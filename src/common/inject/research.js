/* global Zotero, browser */
if (Zotero.isManifestV3 && window.top === window) {
	let researchFrame;
	function isForumPost() {
		return /(^|\.)(?:lesswrong\.com|alignmentforum\.org)$/.test(location.hostname) && location.pathname.startsWith('/posts/');
	}
	function pageText() {
		if (!isForumPost()) {
			return document.body?.innerText || '';
		}
		// Both forums stream the article into a hidden React container. In an
		// inactive tab it can stay hidden after load, so body.innerText misses it.
		const site = /(^|\.)lesswrong\.com$/.test(location.hostname) ? 'LessWrong' : 'Alignment Forum';
		const post = document.querySelector('#postContent')?.cloneNode(true);
		if (!post) throw new Error(`Could not read the ${site} post text. Open the full post and try again.`);
		for (const node of post.querySelectorAll('script, style, noscript')) node.remove();
		for (const node of post.querySelectorAll('br')) node.replaceWith('\n');
		for (const node of post.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, pre, blockquote, section, table, tr')) {
			node.prepend('\n'); node.append('\n');
		}
		for (const node of post.querySelectorAll('th, td')) node.append('\t');
		const text = post.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
		if (!text) throw new Error(`Could not read the ${site} post text. Open the full post and try again.`);
		return text;
	}
	browser.runtime.onMessage.addListener(message => {
		if (!message?.research || message.research === 'panel') return;
		return (async () => {
			if (message.research === 'twitter') return Zotero.ResearchTwitter.capture();
			if (message.research === 'hide') { researchFrame?.remove(); researchFrame = null; return {ok: true}; }
			if (message.research === 'resize') {
				if (researchFrame && Number.isFinite(message.height) && message.height > 0) {
					const minimized = message.mode === 'minimized';
					const docked = minimized || message.mode === 'docked';
					const centered = !docked && message.expanded;
					Object.assign(researchFrame.frame.style, {
						height: `${message.height}px`, width: minimized ? '320px' : docked ? '440px' : message.expanded ? '760px' : '360px',
						maxHeight: docked ? 'min(640px, calc(100vh - 16px))' : 'min(760px, calc(100vh - 32px))',
						top: docked ? 'auto' : centered ? '50%' : '16px', bottom: docked ? '0' : 'auto',
						right: centered ? 'auto' : '16px', left: centered ? '50%' : 'auto',
						transform: centered ? 'translate(-50%, -50%)' : 'none',
						borderRadius: docked ? '14px 14px 0 0' : '16px',
						boxShadow: centered ? '0 18px 80px #0005, 0 0 0 100vmax #15231f55' : '0 12px 60px #0005'
					});
				}
				return {ok: true};
			}
			if (message.research === 'show') {
				// Keep an opaque backing behind the document during macOS scroll bounce.
				if (!researchFrame) researchFrame = new Zotero.Frame({
					src: Zotero.getExtensionURL('research/panel.html'), title: 'Zotero Research', allow: 'clipboard-write',
					'data-single-file-hidden-frame': ''
				}, {position: 'fixed', top: '16px', right: '16px', width: '360px', maxWidth: 'calc(100vw - 32px)',
					height: '280px', maxHeight: 'min(760px, calc(100vh - 32px))', border: '0', borderRadius: '16px',
					background: '#fcfcf9', boxShadow: '0 12px 60px #0005', zIndex: 2147483647, colorScheme: 'light'});
				await researchFrame.init(); return {ok: true};
			}
			if (message.research !== 'extract') return;
			const anthropic = Zotero.ResearchAnthropic.extract();
			const source = {url: location.href, pageText: anthropic?.pageText || pageText(), pdfURLs: []};
			const citationPDFSource = document.querySelector('meta[name="citation_pdf_url"]')?.content;
			if (citationPDFSource) source.pdfURLs.push(new URL(citationPDFSource, location.href).href);
			if (/^(www\.)?arxiv\.org$/.test(location.hostname) && location.pathname.startsWith('/abs/')) source.pdfURLs.push('https://arxiv.org/pdf/' + location.pathname.slice(5));
			const isPDF = /\.pdf(?:$|[?#])/i.test(location.href) || document.contentType === 'application/pdf';
			if (isPDF) source.pdfURLs.push(location.href);
			const withSnapshot = async () => {
				if (message.snapshot && !source.pdfURLs.length) {
					source.snapshotContent = await Zotero.SingleFile.retrievePageData();
				}
				return source;
			};
			if (!message.metadata) return {source: await withSnapshot()};
			let item;
			if (message.detect) await Zotero.PageSaving.onPageLoad();
			let translators = Zotero.PageSaving.translators;
			// The generic DOI translator reports "multiple" for references found
			// anywhere on a page, even a single citation in a tutorial. Those are
			// not metadata for the page itself. Keep ordinary saving unchanged.
			if (translators?.[0]?.itemType === 'multiple'
				&& translators[0].translatorID === 'c159dcfe-8a53-4301-a499-30f6549c340d') {
				translators = translators.slice(1);
			}
			const alignmentForumPost = isForumPost() && /(^|\.)alignmentforum\.org$/.test(location.hostname);
			if (alignmentForumPost) {
				// ForumMagnum supports this site's API, but its URL matcher currently
				// omits Alignment Forum. Keep the detected translators as fallbacks.
				const forum = await Zotero.Translators.get('d9f957ca-6393-48ba-b179-59c384e37a12').catch(error => {
					Zotero.logError(error); return null;
				});
				if (forum) {
					forum.itemType = 'forumPost';
					translators = [forum, ...(translators || []).filter(translator => translator.translatorID !== forum.translatorID)];
				}
			}
			if (translators?.length && translators[0].itemType !== 'multiple') {
				const translate = await Zotero.PageSaving._initTranslate(translators[0].itemType);
				const result = await Zotero.TranslateWeb.translate({translate, translators: translators.slice()});
				[item] = result.items;
			} else if (translators?.[0]?.itemType === 'multiple') {
				throw new Error('Open an individual paper to summarize it. Save to Zotero is still available for lists of papers.');
			} else {
				// Chrome's PDF viewer can have no document title. Use the final URL's
				// filename, as the standard standalone attachment workflow does.
				const title = document.title || (isPDF ? location.pathname.split('/').pop() || location.href : '');
				item = {itemType: 'webpage', title, url: location.href, accessDate: new Date().toISOString(),
					creators: [], tags: [], attachments: []};
			}
			if (!item) throw new Error('The translator did not return a paper.');
			if (anthropic) Zotero.ResearchAnthropic.applyMetadata(item, anthropic);
			if (alignmentForumPost && item.itemType === 'forumPost') item.forumTitle = 'AI Alignment Forum';
			if (isForumPost() && !new URL(location.href).searchParams.has('commentId')) {
				// ForumMagnum can return coauthors without the primary author. The
				// page's citation metadata contains the full byline in display order.
				const names = [...document.querySelectorAll('meta[name="citation_author"]')].map(node => node.content.trim()).filter(Boolean);
				if (names.length) {
					const remaining = [...(item.creators || [])];
					const authors = names.map(name => {
						const index = remaining.findIndex(creator => creator.creatorType === 'author'
							&& [creator.firstName, creator.lastName].filter(Boolean).join(' ') === name);
						return index < 0 ? {lastName: name, creatorType: 'author', fieldMode: 1} : remaining.splice(index, 1)[0];
					});
					item.creators = [...authors, ...remaining];
				}
			}
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
			return {item: {...item, attachments: []}, source: await withSnapshot()};
		})().catch(error => ({error: error.message}));
	});
}
