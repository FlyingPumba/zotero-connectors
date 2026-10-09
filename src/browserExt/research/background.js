/* global Zotero, browser */
Zotero.Research = {
	ordinaryChecks: new Map(),
	async confirmDuplicates(tab, frameId, items, source) {
		const {matches} = await this.call('duplicates', {items, source: {url: source?.url, pdfURLs: source?.pdfURLs}});
		if (!matches.length) return true;
		Zotero.Connector_Browser.setKeepServiceWorkerAlive(true);
		try {
			const result = await browser.tabs.sendMessage(tab.id, {research: 'duplicates', matches}, {frameId});
			return result?.confirmed === true;
		} finally { Zotero.Connector_Browser.setKeepServiceWorkerAlive(false); }
	},
	async show(tab) {
		// Tabs left open across installation/reload have no live content-script listener.
		await Zotero.Connector_Browser.injectTranslationScripts(tab);
		return browser.tabs.sendMessage(tab.id, {research: 'show'}, {frameId: 0});
	},
	isTwitter(url) { return /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(url); },
	async progress(tab, stage) {
		await browser.tabs.sendMessage(tab.id, {research: 'preparing', stage}).catch(() => {});
	},
	async resolveTwitterLink(url) {
		const options = {signal: AbortSignal.timeout(20000), credentials: 'omit'};
		const response = await fetch(url, {...options, method: 'HEAD'});
		const target = {url: response.url, pdf: /application\/pdf/i.test(response.headers.get('Content-Type') || '')};
		if (new URL(target.url).hostname === 't.co') {
			// For Chrome, t.co returns an HTML redirect instead of an HTTP one.
			// Read only that page, without following or executing its redirect.
			const landing = await fetch(url, {...options, method: 'GET', redirect: 'manual'});
			const redirect = (await landing.text()).match(/\blocation\.replace\(\s*("(?:[^"\\]|\\.)*")\s*\)/);
			if (redirect) target.url = JSON.parse(redirect[1]);
		}
		if (new URL(target.url).hostname === 'lnkd.in') {
			// LinkedIn short links expose their destination in an intermediate page.
			const landing = await fetch(target.url, {...options, method: 'GET', redirect: 'manual'});
			const anchor = (await landing.text()).match(/<a\b[^>]*\bdata-tracking-control-name=["']external_url_click["'][^>]*>/i);
			const href = anchor?.[0].match(/\bhref=(["'])(.*?)\1/i)?.[2];
			if (href) target.url = href.replace(/&amp;/g, '&');
		}
		return target;
	},
	async paperLinks(thread) {
		const candidates = new Map();
		const resolved = new Map();
		for (const post of thread.posts) {
			for (const link of post.links) {
				let url = new URL(link.url);
				if (!['http:', 'https:'].includes(url.protocol)) continue;
				if (['t.co', 'lnkd.in'].includes(url.hostname)) {
					// Expand short URLs for the chooser without reading linked pages.
					// An unavailable redirect remains selectable as its original URL.
					if (!resolved.has(url.href)) {
						resolved.set(url.href, await this.resolveTwitterLink(url.href).catch(() => ({url: url.href})));
					}
					const target = resolved.get(url.href);
					url = new URL(target.url);
				}
				if (!['http:', 'https:'].includes(url.protocol)) continue;
				if (/(^|\.)(?:x|twitter)\.com$/.test(url.hostname)) continue;
				const arxiv = /^(?:www\.|export\.)?arxiv\.org$/.test(url.hostname)
					&& url.pathname.match(/^\/(?:abs|pdf|html)\/([^?#]+?)(?:\.pdf)?\/?$/);
				if (arxiv) url = new URL('https://arxiv.org/abs/' + arxiv[1]);
				url.hash = '';
				if (!candidates.has(url.href)) candidates.set(url.href, {url: url.href, label: link.label || url.href});
			}
		}
		return [...candidates.values()];
	},
	async paperChoicePage({url, deadline}) {
		const target = new URL(url);
		if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported title URL');
		// Fetch outside the panel's HTTPS embedding page so HTTP destinations work
		// under the connector's existing host permissions without mixed content.
		const response = await fetch(target.href, {credentials: 'omit', signal: AbortSignal.timeout(Math.max(0, deadline - Date.now()))});
		try {
			const type = response.headers.get('Content-Type') || '';
			const html = response.ok && /text\/html|application\/xhtml\+xml/i.test(type) ? await response.text() : undefined;
			return {url: response.url || target.href, ok: response.ok, type, html};
		} finally {
			// Unselected PDFs and other resources need only their headers.
			if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
		}
	},
	async extractPaper(url, metadata = true, snapshot = false) {
		const tab = await browser.tabs.create({url, active: false});
		try {
			await new Promise((resolve, reject) => {
				const done = error => { clearTimeout(timeout); browser.tabs.onUpdated.removeListener(updated); browser.tabs.onRemoved.removeListener(removed); error ? reject(error) : resolve(); };
				const updated = (id, change) => { if (id === tab.id && change.status === 'complete') done(); };
				const removed = id => { if (id === tab.id) done(new Error('The paper tab was closed before it could be read.')); };
				const timeout = setTimeout(() => done(new Error('The linked paper did not finish loading. Open it and try again.')), 60000);
				browser.tabs.onUpdated.addListener(updated); browser.tabs.onRemoved.addListener(removed);
				browser.tabs.get(tab.id).then(current => { if (current.status === 'complete') done(); }).catch(done);
			});
			await Zotero.Connector_Browser.injectTranslationScripts(await browser.tabs.get(tab.id));
			const extracted = await browser.tabs.sendMessage(tab.id, {research: 'extract', metadata, detect: true, snapshot}, {frameId: 0});
			if (!extracted || extracted.error) throw new Error(extracted?.error || 'Could not read the linked paper.');
			return extracted;
		} finally { await browser.tabs.remove(tab.id).catch(() => {}); }
	},
	async startFromTwitter(tab, data, frameId) {
		const key = 'researchTwitter:' + tab.id;
		let pending = (await browser.storage.session.get(key))[key];
		if (pending?.requestID !== data.requestID || pending.pageURL !== tab.url) {
			await this.progress(tab, 'Reading Twitter thread…');
			const thread = await browser.tabs.sendMessage(tab.id, {research: 'twitter'}, {frameId: 0});
			if (!thread || thread.error) throw new Error(thread?.error || 'Could not read the Twitter thread.');
			await this.progress(tab, 'Reading the URLs linked in the thread…');
			const candidates = await this.paperLinks(thread);
			if (!candidates.length) throw new Error('No paper URL was found in the author’s thread. Open a thread with a link outside X/Twitter, then try again.');
			pending = {requestID: data.requestID, pageURL: tab.url, thread, candidates};
			await browser.storage.session.set({[key]: pending});
		}
		const onlyLink = pending.candidates.length === 1 ? pending.candidates[0] : null;
		const chosen = data.paperURL ? pending.candidates.find(c => c.url === data.paperURL)
			: onlyLink && /^https:\/\/arxiv\.org\/abs\//.test(onlyLink.url) ? onlyLink : null;
		if (!chosen) return {paperChoices: pending.candidates};
		await this.progress(tab, 'Reading the linked paper’s metadata…');
		const extracted = await this.extractPaper(chosen.url, true, data.mode === 'pdf');
		if (!await this.confirmDuplicates(tab, frameId, [extracted.item], extracted.source)) return {cancelled: true};
		const job = await this.call('start', {...data, ...extracted, twitterThread: pending.thread});
		await browser.storage.session.set({['researchTab:' + tab.id]: {id: job.id, displayedURL: tab.url}});
		await browser.storage.session.remove(key);
		return job;
	},
	async call(method, data) {
		try {
			const result = await Zotero.Connector.callMethod({method: 'research/' + method}, data);
			if (result.error) throw new Error(result.error);
			return result;
		} catch (e) {
			if (e.status === 0) {
				throw Object.assign(new Error('Open Zotero to use Zotero Research.'), {zoteroUnavailable: true});
			}
			if (e.status === 404) {
				throw new Error('Open Zotero with the Zotero Research plugin installed, then try again.');
			}
			throw e;
		}
	}
};

browser.runtime.onMessage.addListener((message, sender) => {
	if (message?.research === 'checkDuplicates' && sender.tab) {
		const frameId = Zotero.Research.ordinaryChecks.get(sender.tab.id);
		if (frameId === undefined) return Promise.resolve({error: 'The save panel is no longer open. Try again.'});
		return Zotero.Research.confirmDuplicates(sender.tab, frameId, message.items, message.source)
			.then(confirmed => ({confirmed})).catch(error => ({error: error.message, zoteroUnavailable: error.zoteroUnavailable}));
	}
	if (!message || message.research !== 'panel') return;
	// The web page cannot send privileged commands through the panel's message bridge.
	if (!sender.tab || !sender.url?.startsWith(browser.runtime.getURL('research/panel.html'))) return;
	return (async () => {
		await Zotero.initDeferred.promise;
		const tab = await browser.tabs.get(sender.tab.id);
		const data = message.data || {};
		if (message.action === 'paperChoicePage') return Zotero.Research.paperChoicePage(data);
		if (message.action === 'settings') return Zotero.Research.call('settings', {});
		if (message.action === 'resize') return browser.tabs.sendMessage(tab.id, {research: 'resize', height: data.height, expanded: data.expanded, mode: data.mode}, {frameId: 0});
		if (message.action === 'close') return browser.tabs.sendMessage(tab.id, {research: 'hide'}, {frameId: 0});
		if (message.action === 'ordinary') {
			// Check the local plugin before the usual workflow can offer an online save.
			await Zotero.Research.call('duplicates', {items: []});
			const info = Zotero.Connector_Browser.getTabInfo(tab.id);
			Zotero.Research.ordinaryChecks.set(tab.id, sender.frameId);
			Zotero.Connector_Browser.setKeepServiceWorkerAlive(true);
			try {
				let result;
				if (info.translators?.length) result = await Zotero.Connector_Browser.saveWithTranslator(tab, 0, {fallbackOnFailure: true, researchDuplicateCheck: true});
				else result = await Zotero.Connector_Browser.saveAsWebpage(tab, info.isPDF ? info.frameId : 0, {
					researchDuplicateCheck: true, snapshot: info.isPDF || (Zotero.Connector.isOnline
						? Zotero.Connector.prefs.automaticSnapshots : Zotero.Prefs.get('automaticSnapshots'))});
				return result?.cancelled || result?.error ? result : {ok: true};
			} finally {
				Zotero.Research.ordinaryChecks.delete(tab.id);
				Zotero.Connector_Browser.setKeepServiceWorkerAlive(false);
			}
		}
		if (message.action === 'status') {
			const binding = (await browser.storage.session.get('researchTab:' + tab.id))['researchTab:' + tab.id];
			return Zotero.Research.call('status', {id: data.id || binding?.id, url: tab.url, reconnect: data.reconnect});
		}
		if (message.action === 'command') return Zotero.Research.call('command', {id: data.id});
		if (message.action === 'approve') return Zotero.Research.call('approve', {id: data.id, selected: data.selected});
		if (message.action === 'category') return Zotero.Research.call('category', data);
		if (message.action === 'createCategory') return Zotero.Research.call('createCategory', data);
		if (['chat', 'summarize'].includes(message.action)) {
			const {job} = await Zotero.Research.call('status', {id: data.id, reconnect: true});
			if (job?.threadId && !job.sessionMissing) return Zotero.Research.call(message.action, data);
		}
		if (['start', 'chat', 'retry', 'summarize'].includes(message.action)) {
			const {job: currentJob} = await Zotero.Research.call('status', {id: data.id, url: tab.url});
			const snapshot = message.action === 'start' ? data.mode === 'pdf'
				: message.action === 'retry' && currentJob?.mode === 'pdf' && !currentJob.attachmentKey && !currentJob.source?.pdfURLs?.length;
			if (Zotero.Research.isTwitter(tab.url)) {
				Zotero.Connector_Browser.setKeepServiceWorkerAlive(true);
				try {
					if (message.action === 'start') return await Zotero.Research.startFromTwitter(tab, data, sender.frameId);
					const {job} = await Zotero.Research.call('status', {id: data.id});
					const extracted = await Zotero.Research.extractPaper(job.url, false, snapshot);
					return await Zotero.Research.call(message.action, {...data, source: extracted.source});
				} finally { Zotero.Connector_Browser.setKeepServiceWorkerAlive(false); }
			}
			const extracted = await browser.tabs.sendMessage(tab.id,
				{research: 'extract', metadata: message.action === 'start', snapshot}, {frameId: 0});
			if (!extracted || extracted.error) throw new Error(extracted?.error || 'Could not read this page. Reload it and try again.');
			if (message.action === 'start' && !await Zotero.Research.confirmDuplicates(tab, sender.frameId, [extracted.item], extracted.source)) return {cancelled: true};
			return Zotero.Research.call(message.action, {...data, ...extracted});
		}
		throw new Error('Unknown paper action.');
	})().catch(error => ({error: error.message, zoteroUnavailable: error.zoteroUnavailable}));
});

// Zotero opens a local landing page with an opaque token. Only the extension
// resolves it, so neither item keys nor conversation data go to the paper site.
Zotero.Research.openHandoff = async function(tab) {
	await Zotero.initDeferred.promise;
	const url = new URL(tab.url);
	const launch = await this.call('handoff', {token: url.searchParams.get('token')});
	await browser.storage.session.set({['researchTab:' + tab.id]: {...launch, opening: true}});
	await browser.tabs.update(tab.id, {url: launch.url});
};
browser.tabs.onUpdated.addListener((id, change, tab) => {
	if (change.status !== 'complete') return;
	(async () => {
		await Zotero.initDeferred.promise;
		if (!Zotero.isManifestV3) return;
		const url = new URL(tab.url);
		if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/connector/research/open' && url.searchParams.has('token')) {
			await Zotero.Research.openHandoff(tab); return;
		}
		const key = 'researchTab:' + id, binding = (await browser.storage.session.get(key))[key];
		if (binding?.opening) {
			await Zotero.Research.show(tab);
			await browser.storage.session.set({[key]: {...binding, opening: false, displayedURL: tab.url}});
		} else if (binding && binding.displayedURL !== tab.url) {
			await browser.storage.session.remove(key);
		}
	})().catch(error => Zotero.logError(error));
});
browser.tabs.onRemoved.addListener(id => { if (Zotero.isManifestV3) browser.storage.session.remove(['researchTab:' + id, 'researchTwitter:' + id]).catch(error => Zotero.logError(error)); });
