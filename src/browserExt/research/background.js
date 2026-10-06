/* global Zotero, browser */
Zotero.Research = {
	async show(tab) {
		// Tabs left open across installation/reload have no live content-script listener.
		await Zotero.Connector_Browser.injectTranslationScripts(tab);
		return browser.tabs.sendMessage(tab.id, {research: 'show'}, {frameId: 0});
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
browser.tabs.onRemoved.addListener(id => { if (Zotero.isManifestV3) browser.storage.session.remove('researchTab:' + id).catch(error => Zotero.logError(error)); });
