import {background, offscreen} from '../support/utils.mjs';

describe('Offscreen translation CSP', function () {
	it('parses page styles without CSP errors or changing translator input', async function () {
		const session = await offscreenPage.createCDPSession();
		await session.send('Log.enable');
		const errors = [];
		session.on('Log.entryAdded', ({entry}) => {
			if (entry.source === 'security') errors.push(entry.text);
		});
		try {
			const html = `<!doctype html><head><title>Styled paper</title>
				<meta name="citation_title" content="Styled paper">
				<style>h1 { color: red; }</style></head>
				<body><h1 style="margin: 0">Research result</h1></body>`;
			await background(async html => {
				await Zotero.OffscreenManager.sendMessage('Translate.new', [], {id: -1001}, 0);
				await Zotero.OffscreenManager.sendMessage('Translate.setDocument',
					[html, 'https://example.org/paper', ''], {id: -1001}, 0);
			}, html);
			const result = await offscreen(() => {
				const doc = Zotero.OffscreenTranslate.translateInstances[-1001][0].document;
				return {
					title: doc.querySelector('meta[name="citation_title"]').content,
					text: doc.querySelector('h1').textContent,
					style: doc.querySelector('h1').getAttribute('style'),
					css: doc.querySelector('style').textContent,
					baseURI: doc.baseURI
				};
			});
			assert.deepEqual(result, {title: 'Styled paper', text: 'Research result',
				style: 'margin: 0', css: 'h1 { color: red; }', baseURI: 'https://example.org/paper'});
			await session.send('Runtime.evaluate', {expression: 'document.readyState'});
			assert.isEmpty(errors, errors.join('\n'));
		}
		finally {
			await offscreen(() => Zotero.OffscreenTranslate.onTabClosed(-1001));
			await session.detach();
		}
	});

	it('continues blocking inline scripts and direct network requests', async function () {
		const result = await offscreen(async () => {
			const script = document.createElement('script');
			script.textContent = 'globalThis.__offscreenCSPTest = true';
			document.body.appendChild(script);
			const inlineScriptRan = globalThis.__offscreenCSPTest === true;
			script.remove();
			delete globalThis.__offscreenCSPTest;
			const violation = new Promise(resolve => {
				const onViolation = event => {
					if (event.effectiveDirective !== 'connect-src') return;
					document.removeEventListener('securitypolicyviolation', onViolation);
					resolve({directive: event.effectiveDirective, disposition: event.disposition});
				};
				document.addEventListener('securitypolicyviolation', onViolation);
			});
			await fetch('https://example.org/offscreen-csp-test').catch(() => {});
			return {inlineScriptRan, network: await violation};
		});
		assert.isFalse(result.inlineScriptRan);
		assert.deepEqual(result.network, {directive: 'connect-src', disposition: 'enforce'});
	});
});
