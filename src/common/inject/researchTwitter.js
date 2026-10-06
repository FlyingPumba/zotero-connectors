/* global Zotero */
// Read the rendered conversation, including posts loaded as the page scrolls.
// No private Twitter API, cookies, or page application state is needed.
Zotero.ResearchTwitter = {
	postURL(value) {
		try {
			const url = new URL(value, location.href);
			const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/);
			if (!/^(?:www\.|mobile\.)?(?:twitter|x)\.com$/.test(url.hostname) || !match) return null;
			return {url: `https://x.com/${match[1]}/status/${match[2]}`, author: match[1], id: match[2]};
		} catch { return null; }
	},
	readPost(article) {
		const time = article.querySelector('time'), identity = this.postURL(time?.closest('a')?.href);
		if (!identity) return null;
		const name = article.querySelector('[data-testid="User-Name"]');
		const text = article.querySelector('[data-testid="tweetText"]');
		const quoteText = [...article.querySelectorAll('[data-testid="tweetText"]')].slice(1);
		const links = [...(text?.querySelectorAll('a[href]') || []), ...article.querySelectorAll('[data-testid="card.wrapper"] a[href]')]
			.filter(a => !a.closest('div[role="link"]'))
			.map(a => ({url: a.href, label: a.textContent.trim(), card: !!a.closest('[data-testid="card.wrapper"]')}));
		const pictures = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map(img => ({url: img.src, alt: img.alt || ''}));
		return {...identity, authorName: name?.querySelector('a')?.textContent || identity.author,
			date: time.dateTime, text: text?.textContent || '', links, pictures,
			quotes: quoteText.map(node => ({text: node.textContent,
				author: node.closest('div[role="link"]')?.querySelector('[data-testid="User-Name"]')?.textContent || ''})),
			truncated: !!article.querySelector('[data-testid="tweet-text-show-more-link"]')};
	},
	async capture() {
		const origin = this.postURL(location.href);
		if (!origin) throw new Error('Open the Twitter post for this paper first.');
		const scroll = {x: window.scrollX, y: window.scrollY};
		const posts = new Map();
		const waitForRender = () => new Promise(resolve => setTimeout(resolve, 700));
		const started = Date.now();
		try {
			window.scrollTo({top: 0, behavior: 'instant'});
			await waitForRender();
			let found = false, finished = false;
			while (!finished) {
				if (location.pathname !== new URL(origin.url).pathname) throw new Error('The Twitter page changed while reading the thread. Try again on the post.');
				let last;
				const recommendations = [...document.querySelectorAll('h2,[role="heading"]')]
					.find(node => /^(Discover more|More posts)$/.test(node.textContent.trim()));
				for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
					if (found && recommendations && (recommendations.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING)) { finished = true; break; }
					const post = this.readPost(article);
					if (!post) continue;
					if (post.id === origin.id) found = true;
					if (!found) continue;
					if (post.author.toLowerCase() !== origin.author.toLowerCase()) { finished = true; break; }
					if (post.truncated) {
						const more = article.querySelector('[data-testid="tweet-text-show-more-link"]');
						more.click(); await waitForRender();
						const expanded = this.readPost(article);
						if (!expanded || expanded.truncated) throw new Error('Expand the author’s post with “Show more”, then try again.');
						posts.set(post.id, expanded);
					} else posts.set(post.id, post);
					last = article;
				}
				if (found && finished) break;
				if (found && !document.querySelector('[role="progressbar"]') && window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2) break;
				if (Date.now() - started > 60000) throw new Error('Twitter has not finished loading the thread. Load its remaining posts and try again.');
				if (last) last.scrollIntoView({block: 'start', behavior: 'instant'});
				else window.scrollBy({top: innerHeight, behavior: 'instant'});
				await waitForRender();
				// Move beyond the last captured post so Twitter loads the next part.
				window.scrollBy({top: innerHeight / 2, behavior: 'instant'});
				await waitForRender();
			}
			if (!posts.size) throw new Error('Could not read this Twitter post. Let it finish loading, then try again.');
			return {url: origin.url, capturedAt: new Date().toISOString(), posts: [...posts.values()]};
		} finally { window.scrollTo({left: scroll.x, top: scroll.y, behavior: 'instant'}); }
	}
};
