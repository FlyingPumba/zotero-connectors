/* global Zotero, browser */
Zotero.Research = {
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
		return target;
	},
	async paperLinks(thread) {
		const candidates = new Map();
		const resolved = new Map();
		for (const post of thread.posts) {
			for (const link of post.links) {
				let url = new URL(link.url), pdf = /\.pdf(?:$|[?#])/i.test(url.href);
				const primary = link.card && /(?:^|\n)Paper:\s*$|(?:check out|read) (?:our|the) paper|(?:our|the) paper (?:is |here)/i.test(post.text);
				if (url.hostname === 't.co') {
					// Only resolve links presented as papers; code, profiles, and other
					// resources remain links in the saved note.
					if (!primary && !/arxiv\.org|\.pdf\b|openreview\.net\/pdf/i.test(link.label)) continue;
					if (!resolved.has(url.href)) {
						resolved.set(url.href, await this.resolveTwitterLink(url.href));
					}
					const target = resolved.get(url.href);
					url = new URL(target.url); pdf = target.pdf || /\.pdf(?:$|[?#])/i.test(url.href);
				}
				const arxiv = /^(?:www\.|export\.)?arxiv\.org$/.test(url.hostname)
					&& url.pathname.match(/^\/(?:abs|pdf|html)\/([^?#]+?)(?:\.pdf)?\/?$/);
				if (!arxiv && !pdf) continue;
				if (arxiv) url = new URL('https://arxiv.org/abs/' + arxiv[1]);
				url.hash = '';
				const old = candidates.get(url.href);
				if (!old || primary) candidates.set(url.href, {url: url.href, label: link.label || url.href, primary: primary || old?.primary || false});
			}
		}
		return [...candidates.values()];
	},
	async extractPaper(url, metadata = true) {
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
			const extracted = await browser.tabs.sendMessage(tab.id, {research: 'extract', metadata, detect: true}, {frameId: 0});
			if (!extracted || extracted.error) throw new Error(extracted?.error || 'Could not read the linked paper.');
			return extracted;
		} finally { await browser.tabs.remove(tab.id).catch(() => {}); }
	},
	async startFromTwitter(tab, data) {
		const key = 'researchTwitter:' + tab.id;
		let pending = (await browser.storage.session.get(key))[key];
		if (pending?.requestID !== data.requestID || pending.pageURL !== tab.url) {
			await this.progress(tab, 'Reading Twitter thread…');
			const thread = await browser.tabs.sendMessage(tab.id, {research: 'twitter'}, {frameId: 0});
			if (!thread || thread.error) throw new Error(thread?.error || 'Could not read the Twitter thread.');
			await this.progress(tab, 'Finding the paper linked in the thread…');
			const candidates = await this.paperLinks(thread);
			if (!candidates.length) throw new Error('No arXiv or PDF link was found in the author’s thread.');
			pending = {requestID: data.requestID, pageURL: tab.url, thread, candidates};
			await browser.storage.session.set({[key]: pending});
		}
		const primary = pending.candidates.filter(c => c.primary);
		const chosen = data.paperURL ? pending.candidates.find(c => c.url === data.paperURL)
			: pending.candidates.length === 1 ? pending.candidates[0] : primary.length === 1 ? primary[0] : null;
		if (!chosen) return {paperChoices: pending.candidates};
		await this.progress(tab, 'Reading the linked paper’s metadata…');
		const extracted = await this.extractPaper(chosen.url);
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
			if (e.status === 404 || e.status === 0) {
				throw new Error('Open Zotero with the Zotero Research plugin installed, then try again.');
			}
			throw e;
		}
	}
};

browser.runtime.onMessage.addListener((message, sender) => {
	if (!message || message.research !== 'panel') return;
	// The web page cannot send privileged commands through the panel's message bridge.
	if (!sender.tab || !sender.url?.startsWith(browser.runtime.getURL('research/panel.html'))) return;
	return (async () => {
		await Zotero.initDeferred.promise;
		const tab = await browser.tabs.get(sender.tab.id);
		const data = message.data || {};
		if (message.action === 'resize') return browser.tabs.sendMessage(tab.id, {research: 'resize', height: data.height, expanded: data.expanded}, {frameId: 0});
		if (message.action === 'close') return browser.tabs.sendMessage(tab.id, {research: 'hide'}, {frameId: 0});
		if (message.action === 'ordinary') {
			const info = Zotero.Connector_Browser.getTabInfo(tab.id);
			if (info.translators?.length) await Zotero.Connector_Browser.saveWithTranslator(tab, 0, {fallbackOnFailure: true});
			else await Zotero.Connector_Browser.saveAsWebpage(tab, 0, {snapshot: Zotero.Connector.isOnline
				? Zotero.Connector.prefs.automaticSnapshots : Zotero.Prefs.get('automaticSnapshots')});
			return {ok: true};
		}
		if (message.action === 'status') {
			const binding = (await browser.storage.session.get('researchTab:' + tab.id))['researchTab:' + tab.id];
			return Zotero.Research.call('status', {id: data.id || binding?.id, url: tab.url, reconnect: data.reconnect});
		}
		if (message.action === 'command') return Zotero.Research.call('command', {id: data.id});
		if (message.action === 'approve') return Zotero.Research.call('approve', {id: data.id, selected: data.selected});
		if (message.action === 'category') return Zotero.Research.call('category', data);
		if (['chat', 'summarize'].includes(message.action)) {
			const {job} = await Zotero.Research.call('status', {id: data.id, reconnect: true});
			if (job?.threadId && !job.sessionMissing) return Zotero.Research.call(message.action, data);
		}
		if (['start', 'chat', 'retry', 'summarize'].includes(message.action)) {
			await Zotero.Research.call('status', {url: tab.url});
			if (Zotero.Research.isTwitter(tab.url)) {
				Zotero.Connector_Browser.setKeepServiceWorkerAlive(true);
				try {
					if (message.action === 'start') return await Zotero.Research.startFromTwitter(tab, data);
					const {job} = await Zotero.Research.call('status', {id: data.id});
					const extracted = await Zotero.Research.extractPaper(job.url, false);
					return await Zotero.Research.call(message.action, {...data, source: extracted.source});
				} finally { Zotero.Connector_Browser.setKeepServiceWorkerAlive(false); }
			}
			const extracted = await browser.tabs.sendMessage(tab.id,
				{research: 'extract', metadata: message.action === 'start'}, {frameId: 0});
			if (!extracted || extracted.error) throw new Error(extracted?.error || 'Could not read this page. Reload it and try again.');
			return Zotero.Research.call(message.action, {...data, ...extracted});
		}
		throw new Error('Unknown paper action.');
	})().catch(error => ({error: error.message}));
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
