/* global Zotero, browser */
Zotero.Research = {
	async show(tab) {
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
		if (message.action === 'resize') return browser.tabs.sendMessage(tab.id, {research: 'resize', height: data.height}, {frameId: 0});
		if (message.action === 'close') return browser.tabs.sendMessage(tab.id, {research: 'hide'}, {frameId: 0});
		if (message.action === 'ordinary') {
			const info = Zotero.Connector_Browser.getTabInfo(tab.id);
			if (info.translators?.length) await Zotero.Connector_Browser.saveWithTranslator(tab, 0, {fallbackOnFailure: true});
			else await Zotero.Connector_Browser.saveAsWebpage(tab, 0, {snapshot: Zotero.Connector.isOnline
				? Zotero.Connector.prefs.automaticSnapshots : Zotero.Prefs.get('automaticSnapshots')});
			return {ok: true};
		}
		if (message.action === 'status') return Zotero.Research.call('status', {id: data.id, url: tab.url});
		if (message.action === 'approve') return Zotero.Research.call('approve', {id: data.id, selected: data.selected});
		if (['start', 'chat', 'retry'].includes(message.action)) {
			await Zotero.Research.call('status', {url: tab.url});
			const extracted = await browser.tabs.sendMessage(tab.id,
				{research: 'extract', metadata: message.action === 'start'}, {frameId: 0});
			if (!extracted || extracted.error) throw new Error(extracted?.error || 'Could not read this page. Reload it and try again.');
			return Zotero.Research.call(message.action, {...data, ...extracted});
		}
		throw new Error('Unknown paper action.');
	})().catch(error => ({error: error.message}));
});
