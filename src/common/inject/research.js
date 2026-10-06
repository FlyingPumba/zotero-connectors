/* global Zotero, browser */
if (Zotero.isManifestV3 && window.top === window) {
	let researchFrame;
	browser.runtime.onMessage.addListener(message => {
		if (!message?.research || message.research === 'panel') return;
		return (async () => {
			if (message.research === 'twitter') return Zotero.ResearchTwitter.capture();
			if (message.research === 'hide') { researchFrame?.remove(); researchFrame = null; return {ok: true}; }
			if (message.research === 'resize') {
				if (researchFrame && Number.isFinite(message.height) && message.height > 0) {
					Object.assign(researchFrame.frame.style, {
						height: `${message.height}px`, width: message.expanded ? '760px' : '360px',
						top: message.expanded ? '50%' : '16px', right: message.expanded ? 'auto' : '16px',
						left: message.expanded ? '50%' : 'auto', transform: message.expanded ? 'translate(-50%, -50%)' : 'none',
						boxShadow: message.expanded ? '0 18px 80px #0005, 0 0 0 100vmax #15231f55' : '0 12px 60px #0005'
					});
				}
				return {ok: true};
			}
			if (message.research === 'show') {
				if (!researchFrame) researchFrame = new Zotero.Frame({
					src: Zotero.getExtensionURL('research/panel.html'), title: 'Zotero Research', allow: 'clipboard-write',
					'data-single-file-hidden-frame': ''
				}, {position: 'fixed', top: '16px', right: '16px', width: '360px', maxWidth: 'calc(100vw - 32px)',
					height: '280px', maxHeight: 'min(760px, calc(100vh - 32px))', border: '0', borderRadius: '16px',
					boxShadow: '0 12px 60px #0005', zIndex: 2147483647, colorScheme: 'light'});
				await researchFrame.init(); return {ok: true};
			}
			if (message.research !== 'extract') return;
			const source = {url: location.href, pageText: document.body?.innerText || '', pdfURLs: []};
			const citationPDFSource = document.querySelector('meta[name="citation_pdf_url"]')?.content;
			if (citationPDFSource) source.pdfURLs.push(new URL(citationPDFSource, location.href).href);
			if (/^(www\.)?arxiv\.org$/.test(location.hostname) && location.pathname.startsWith('/abs/')) source.pdfURLs.push('https://arxiv.org/pdf/' + location.pathname.slice(5));
			if (/\.pdf(?:$|[?#])/i.test(location.href) || document.contentType === 'application/pdf') source.pdfURLs.push(location.href);
			if (!message.metadata) return {source};
			let item;
			if (message.detect) await Zotero.PageSaving.onPageLoad();
			const translators = Zotero.PageSaving.translators;
			if (translators?.length && translators[0].itemType !== 'multiple') {
				const translate = await Zotero.PageSaving._initTranslate(translators[0].itemType);
				const result = await Zotero.TranslateWeb.translate({translate, translators: translators.slice()});
				[item] = result.items;
			} else if (translators?.[0]?.itemType === 'multiple') {
				throw new Error('Open an individual paper to summarize it. Save to Zotero is still available for lists of papers.');
			} else {
				item = {itemType: 'webpage', title: document.title, url: location.href, accessDate: new Date().toISOString(),
					creators: [], tags: [], attachments: []};
			}
			if (!item) throw new Error('The translator did not return a paper.');
			for (const attachment of item.attachments || []) {
				if ((attachment.mimeType || attachment.contentType) === 'application/pdf' && attachment.url) {
					source.pdfURLs.push(new URL(attachment.url, location.href).href);
				}
			}
			const citationPDF = document.querySelector('meta[name="citation_pdf_url"]')?.content;
			if (citationPDF) source.pdfURLs.push(new URL(citationPDF, location.href).href);
			if (/^(www\.)?arxiv\.org$/.test(location.hostname) && location.pathname.startsWith('/abs/')) {
				source.pdfURLs.push('https://arxiv.org/pdf/' + location.pathname.slice(5));
			}
			source.pdfURLs = [...new Set(source.pdfURLs)];
			return {item: {...item, attachments: []}, source};
		})().catch(error => ({error: error.message}));
	});
}
