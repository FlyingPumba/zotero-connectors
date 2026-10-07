/* global marked, katex */
// Recognize math before Markdown consumes backslash delimiters or underscores.
function mathToken(source) {
	const open = /^(\\\(|\\\[|\$\$|\$)/.exec(source)?.[0];
	if (!open) return;
	const close = {'\\(': '\\)', '\\[': '\\]', '$$': '$$', '$': '$'}[open];
	const display = open === '\\[' || open === '$$';
	if (open === '$' && /^\s/.test(source.slice(1))) return;
	let braces = 0;
	for (let i = open.length; i < source.length; i++) {
		if (!braces && source.startsWith(close, i)) {
			// Do not mistake prose such as "$5 and $10" for inline math.
			if (open === '$' && (/\s/.test(source[i - 1]) || /[\d$]/.test(source[i + 1] || ''))) return;
			const text = source.slice(open.length, i);
			if (!text.trim()) return;
			return {raw: source.slice(0, i + close.length), text, display};
		}
		if (source[i] === '\\') i++;
		else if (source[i] === '{') braces++;
		else if (source[i] === '}') braces = Math.max(0, braces - 1);
		else if (open === '$' && source[i] === '\n') return;
	}
}
function mathHTML(token) {
	const text = token.text.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
	return `<span class="research-math${token.display ? ' research-math-display' : ''}">${text}</span>`;
}
const mathMarkdown = new marked.Marked({extensions: [{
	name: 'displayMath', level: 'block',
	start: source => source.search(/(?:^|\n) {0,3}(?:\\\[|\$\$)/),
	tokenizer(source) {
		const indent = /^ {0,3}/.exec(source)[0];
		const token = mathToken(source.slice(indent.length));
		if (!token?.display) return;
		const rest = source.slice(indent.length + token.raw.length);
		if (!/^[ \t]*(?:\n|$)/.test(rest)) return;
		return {...token, type: 'displayMath', raw: indent + token.raw};
	},
	renderer: token => mathHTML(token)
}, {
	name: 'inlineMath', level: 'inline',
	start: source => source.search(/\\[([]|\$/),
	tokenizer(source) {
		const token = mathToken(source);
		if (token) return {...token, type: 'inlineMath'};
	},
	renderer: token => mathHTML(token)
}]});
function typesetMath(node) {
	for (const formula of node.querySelectorAll('.research-math')) {
		katex.render(formula.textContent, formula, {
			displayMode: formula.classList.contains('research-math-display'),
			throwOnError: false, trust: false
		});
	}
}
// Summaries retain their existing plain-text formatting outside formulas.
function textMath(node, text) {
	node.replaceChildren();
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const token = mathToken(text.slice(i));
		if (token) {
			node.append(document.createTextNode(text.slice(start, i)));
			const formula = document.createElement('span');
			formula.className = 'research-math' + (token.display ? ' research-math-display' : '');
			formula.textContent = token.text; node.append(formula);
			i += token.raw.length - 1; start = i + 1;
		} else if (text[i] === '\\') i++;
	}
	node.append(document.createTextNode(text.slice(start)));
	typesetMath(node);
}
