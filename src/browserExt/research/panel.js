/* global browser, marked, DOMPurify, mathMarkdown, typesetMath, textMath */
const $ = id => document.getElementById(id);
let job, busy = false, timer, requestID = crypto.randomUUID(), approvalID, messageSnapshot, actionStartedAt, activeAction, categorySnapshot, categoryBusy = false;
let panelMode = 'floating', minimizedScrollY = 0;
browser.runtime.onMessage.addListener(message => {
	if (message?.research === 'preparing' && busy && activeAction === 'start') $('status').textContent = message.stage;
});
async function call(action, data = {}) {
	const result = await browser.runtime.sendMessage({research: 'panel', action, data});
	if (!result || result.error) throw new Error(result?.error || 'The Connector could not respond. Reload this page and try again.');
	return result;
}
function error(e) { $('error').textContent = e.message; $('error').hidden = false; }
async function describePaperChoice(choice, title, url) {
	const linkLabel = choice.label?.trim();
	const fallback = linkLabel && !/^(?:https?:\/\/|www\.)/i.test(linkLabel) ? linkLabel : 'Title unavailable';
	try {
		const deadline = Date.now() + 20000, seen = new Set();
		let target = choice.url;
		while (true) {
			const response = await call('paperChoicePage', {url: target, deadline});
			url.textContent = response.url || target;
			seen.add(target); seen.add(url.textContent);
			if (!response.ok) throw new Error('Title lookup failed');
			const type = response.type;
			if (/application\/pdf/i.test(type)) {
				// Titles are best-effort previews. Do not download an unselected PDF.
				title.textContent = decodeURIComponent(new URL(url.textContent).pathname.split('/').pop()) || fallback;
				return;
			}
			if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error('No page title');
			const doc = new DOMParser().parseFromString(response.html, 'text/html');
			const refresh = doc.querySelector('meta[http-equiv="refresh" i]')?.content.match(/^\s*[\d.]+\s*;\s*url\s*=\s*(.*?)\s*$/i);
			if (refresh) {
				const next = new URL(refresh[1].replace(/^(['"])(.*)\1$/, '$2'), url.textContent);
				if (['http:', 'https:'].includes(next.protocol) && !seen.has(next.href)) { target = next.href; continue; }
			}
			const pageTitle = ['meta[name="citation_title"]', 'meta[property="og:title"]', 'meta[name="twitter:title"]']
				.map(selector => doc.querySelector(selector)?.content).concat(doc.title)
				.find(value => value?.trim());
			title.textContent = pageTitle?.replace(/\s+/g, ' ').trim() || fallback;
			return;
		}
	} catch { title.textContent = fallback; }
}
function markdownHTML(text, parser = mathMarkdown) {
	return DOMPurify.sanitize(parser.parse(text || ''), {
		ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'a', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
			'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
			...(parser === mathMarkdown ? ['span'] : [])],
		ALLOWED_ATTR: ['href', 'title', 'start', 'class']
	});
}
function markdown(node, text) {
	node.innerHTML = markdownHTML(text);
	typesetMath(node);
	for (const link of node.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
}
function renderSavedDiscussion(html) {
	const template = document.createElement('template');
	template.innerHTML = DOMPurify.sanitize(html);
	let content;
	for (const node of [...template.content.childNodes]) {
		if (node.nodeName === 'H2' && ['User', 'Assistant'].includes(node.textContent)) {
			const block = document.createElement('div'), name = document.createElement('strong');
			block.className = 'message ' + node.textContent.toLowerCase();
			name.className = 'message-role'; name.textContent = node.textContent;
			content = document.createElement('div'); content.className = 'markdown';
			block.append(name, content); $('messages').append(block);
		} else {
			if (!content) { content = document.createElement('div'); content.className = 'markdown'; $('messages').append(content); }
			content.append(node);
		}
	}
	const blocks = [...$('messages').querySelectorAll('.message')];
	const saved = (job.messages || []).slice(0, job.discussionMessageCount || 0);
	if (blocks.length === saved.length) {
		blocks.forEach((block, index) => {
			if (saved[index].role !== 'assistant' || !block.classList.contains('assistant')) return;
			const content = block.lastElementChild;
			// Older notes have already lost their math delimiters to Markdown.
			// Re-render from the original only when the saved answer is unchanged.
			const original = document.createElement('div'); original.innerHTML = markdownHTML(saved[index].text, marked);
			const normalized = node => [...node.childNodes].filter(n => n.nodeType !== Node.TEXT_NODE || n.textContent.trim()).map(n => n.outerHTML || n.textContent).join('');
			if (normalized(content) === normalized(original)) markdown(content, saved[index].text);
		});
	}
	for (const link of $('messages').querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
}
function renderCategories() {
	const snapshot = JSON.stringify([job.existingCollections, job.availableCollections, categoryBusy]);
	if (snapshot === categorySnapshot) return;
	categorySnapshot = snapshot;
	const focusedKey = document.activeElement?.dataset.key;
	const selected = new Set((job.existingCollections || []).map(c => c.key));
	$('categoryChips').replaceChildren();
	for (const category of job.existingCollections || []) {
		const chip = document.createElement('span'), remove = document.createElement('button');
		chip.className = 'category-chip'; chip.title = category.path;
		remove.textContent = '×'; remove.className = 'chip-remove';
		remove.setAttribute('aria-label', `Remove ${category.path}`); remove.disabled = categoryBusy;
		remove.onclick = () => setCategory(category.key, false);
		chip.append(document.createTextNode(category.path), remove); $('categoryChips').append(chip);
	}
	if (!selected.size) {
		const empty = document.createElement('span'); empty.className = 'hint'; empty.textContent = 'No categories selected'; $('categoryChips').append(empty);
	}
	$('categoryOptions').replaceChildren();
	for (const category of [...(job.availableCollections || [])].sort((a, b) => a.path.localeCompare(b.path))) {
		const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
		input.type = 'checkbox'; input.checked = selected.has(category.key); input.dataset.key = category.key; input.disabled = categoryBusy;
		input.onchange = () => setCategory(category.key, input.checked);
		text.textContent = category.path; label.append(input, text); $('categoryOptions').append(label);
		if (focusedKey === category.key) input.focus();
	}
	filterCategories();
	for (const id of ['newCategory', 'newCategoryName', 'newCategoryParent', 'cancelNewCategory']) $(id).disabled = categoryBusy;
	updateNewCategory();
}
function showNewCategory(open) {
	$('newCategoryForm').hidden = !open;
	$('newCategory').setAttribute('aria-expanded', String(open));
	if (!open) return;
	$('categoryPicker').open = false;
	const parent = $('newCategoryParent'), selected = parent.value;
	const previous = parent.selectedOptions[0]?.textContent;
	parent.replaceChildren(new Option('Top level', ''));
	for (const category of [...(job.availableCollections || [])].sort((a, b) => a.path.localeCompare(b.path))) {
		parent.add(new Option(category.path, category.key));
	}
	// Preserve a draft's parent even if it was deleted elsewhere. Saving can
	// then report the missing category instead of silently using the top level.
	if (selected && ![...parent.options].some(option => option.value === selected)) parent.add(new Option(previous, selected));
	parent.value = selected;
	$('newCategoryError').hidden = true;
	updateNewCategory();
	$('newCategoryName').focus();
}
function updateNewCategory() {
	const name = $('newCategoryName').value.trim(), parentKey = $('newCategoryParent').value || null;
	const existing = (job.availableCollections || []).find(c => c.name === name && (c.parentKey || null) === parentKey);
	$('createCategory').disabled = categoryBusy || !name;
	$('createCategory').textContent = categoryBusy ? 'Saving…' : existing ? 'Add existing category' : 'Create & add';
	$('newCategoryHint').textContent = existing ? 'This category already exists. This paper will be added to it.'
		: name ? `Creates ${[$('newCategoryParent').value ? $('newCategoryParent').selectedOptions[0].textContent : '', name].filter(Boolean).join(' / ')} and adds this paper to it.`
		: 'Creates a Zotero category and adds this paper to it.';
}
async function createCategory(event) {
	event.preventDefault();
	const name = $('newCategoryName').value.trim();
	if (categoryBusy || !name) return;
	categoryBusy = true; $('newCategoryError').hidden = true;
	$('categoryStatus').textContent = 'Saving…'; $('categoryStatus').classList.remove('failed'); renderCategories();
	try {
		const updated = await call('createCategory', {id: job.id, name, parentKey: $('newCategoryParent').value || null});
		job.existingCollections = updated.existingCollections; job.availableCollections = updated.availableCollections;
		$('categoryStatus').textContent = 'Saved to Zotero';
		$('newCategoryForm').reset(); showNewCategory(false);
	} catch (e) {
		$('newCategoryError').textContent = e.message; $('newCategoryError').hidden = false;
		$('categoryStatus').textContent = '';
	} finally {
		categoryBusy = false; renderCategories();
		if ($('newCategoryForm').hidden) $('newCategory').focus();
	}
}
function filterCategories() {
	const query = $('categorySearch').value.trim().toLocaleLowerCase();
	let visible = 0;
	for (const label of $('categoryOptions').children) { label.hidden = !label.textContent.toLocaleLowerCase().includes(query); if (!label.hidden) visible++; }
	$('noCategories').hidden = !!visible;
}
async function setCategory(key, selected) {
	if (categoryBusy) return;
	categoryBusy = true; $('categoryStatus').textContent = 'Saving…'; $('categoryStatus').classList.remove('failed'); renderCategories();
	try {
		const updated = await call('category', {id: job.id, key, selected});
		// Keep progress/chat state from polling; this operation only changes memberships.
		job.existingCollections = updated.existingCollections; job.availableCollections = updated.availableCollections;
		$('categoryStatus').textContent = 'Saved to Zotero';
	} catch (e) { $('categoryStatus').textContent = e.message; $('categoryStatus').classList.add('failed'); }
	finally { categoryBusy = false; renderCategories(); }
}
function updateProgress() {
	const active = busy || ['ingesting', 'chatting', 'summarizing'].includes(job?.status);
	const chatting = activeAction === 'chat' || job?.status === 'chatting';
	const summarizing = activeAction === 'summarize' || job?.status === 'summarizing';
	const progress = $('progress'), anchor = chatting ? $('partial') : summarizing ? $('produceSummary') : $('error');
	if (progress.nextElementSibling !== anchor) anchor.before(progress);
	progress.hidden = !active || (chatting && !!job?.partial);
	updateActivity();
}
function updateActivity() {
	const active = busy || ['ingesting', 'chatting', 'summarizing'].includes(job?.status);
	$('activity').hidden = !active;
	const started = busy ? actionStartedAt : Date.parse(job?.operationStartedAt || (job?.status === 'ingesting' ? job.createdAt : ''));
	$('elapsed').hidden = !active || !Number.isFinite(started);
	if (!$('elapsed').hidden) {
		const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
		const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		$('elapsed').textContent = [job?.model, `${duration} elapsed`].filter(Boolean).join(' · ');
	}
}
function render(next) {
	job = next;
	$('actions').hidden = !!job;
	$('footer').hidden = !job;
	const expanded = !!job && (['ready', 'chatting', 'summarizing'].includes(job.status) || !!job.summary);
	document.body.classList.toggle('results', expanded);
	$('title').hidden = !expanded;
	$('paper').hidden = !expanded;
	$('summary').hidden = !job?.summary;
	$('produceSummary').hidden = !!job?.summary;
	$('produceSummary').disabled = busy || job?.status !== 'ready';
	$('categories').hidden = !expanded;
	$('status').textContent = job ? (/^Reading paper and/.test(job.stage) ? `Codex: ${job.stage}` : job.stage) : '';
	updateProgress();
	$('error').hidden = !(job?.error || job?.reconnectError);
	if (job?.error || job?.reconnectError) $('error').textContent = job.error || job.reconnectError;
	$('notice').textContent = [job?.notice, job?.twitterWarning].filter(Boolean).join(' ');
	$('notice').hidden = !$('notice').textContent;
	$('retry').hidden = job?.status !== 'error';
	const reviewPending = ['ready', 'chatting', 'summarizing'].includes(job?.status) && !!job?.proposedCollections?.length && !Array.isArray(job.approved);
	$('approval').hidden = !reviewPending;
	$('chat').hidden = !['ready', 'chatting', 'summarizing'].includes(job?.status);
	if (!job) return;
	$('title').textContent = job.title;
	textMath($('summary'), job.summary || '');
	renderCategories();
	$('session').hidden = !job.threadId || job.sessionMissing;
	$('sessionCommand').textContent = job.threadId ? `codex resume ${job.threadId}` : '';
	if (reviewPending && approvalID !== job.id) {
		approvalID = job.id; $('proposals').replaceChildren();
		job.proposedCollections.forEach((proposal, index) => {
			const label = document.createElement('label'), checkbox = document.createElement('input'), reason = document.createElement('small');
			checkbox.type = 'checkbox'; checkbox.value = index;
			label.append(checkbox, ' ' + (proposal.parentPath ? proposal.parentPath + ' / ' : '') + proposal.name);
			reason.textContent = proposal.reason; label.append(reason); $('proposals').append(label);
		});
	}
	const snapshot = JSON.stringify([job.messages, job.discussionHTML, job.discussionMessageCount]);
	if (snapshot !== messageSnapshot) {
		messageSnapshot = snapshot; $('messages').replaceChildren();
		if (job.discussionHTML != null) renderSavedDiscussion(job.discussionHTML);
		for (const message of (job.messages || []).slice(job.discussionHTML == null ? 0 : job.discussionMessageCount || 0)) {
			const block = document.createElement('div'), name = document.createElement('strong');
			block.className = 'message ' + message.role; name.className = 'message-role'; name.textContent = message.role === 'user' ? 'User' : 'Assistant';
			const content = document.createElement('div');
			if (message.role === 'assistant') { content.className = 'markdown'; markdown(content, message.text); }
			else content.textContent = message.text;
			block.append(name, content); $('messages').append(block);
		}
	}
	markdown($('partialContent'), job.partial);
	$('partial').hidden = !job.partial;
	$('send').disabled = busy || job.status !== 'ready';
	$('question').disabled = job.status === 'chatting';
}
async function refresh(reconnect = false) {
	try { const result = await call('status', {id: job?.id, reconnect}); render(result.job); }
	catch (e) { render(job); error(e); }
	clearTimeout(timer);
	if (job && ['ingesting', 'chatting', 'summarizing'].includes(job.status)) timer = setTimeout(refresh, 1000);
}
async function act(action, data) {
	if (busy) return;
	if (action === 'start') $('ordinary').hidden = true;
	busy = true; activeAction = action; actionStartedAt = Date.now(); $('error').hidden = true;
	updateProgress();
	for (const id of ['entry', 'pdf', 'categorize', 'approve', 'skip', 'retry', 'send', 'produceSummary']) $(id).disabled = true;
	try {
		$('status').textContent = action === 'start' ? 'Reading metadata and adding entry…' : 'Working…';
		const result = await call(action, data);
		if (result.paperChoices) {
			$('actions').hidden = true; $('paperChoice').hidden = false; $('paperChoices').replaceChildren();
			for (const choice of result.paperChoices) {
				const button = document.createElement('button'), title = document.createElement('span'), url = document.createElement('small');
				button.className = 'secondary'; title.textContent = 'Loading title…';
				url.textContent = choice.url; button.append(title, url);
				button.onclick = () => act('start', {...data, paperURL: choice.url});
				$('paperChoices').append(button);
				describePaperChoice(choice, title, url);
			}
			return;
		}
		$('paperChoice').hidden = true;
		render(result);
		if (action === 'chat') $('question').value = '';
		await refresh();
	} catch (e) { error(e); }
	finally {
		busy = false; activeAction = null; updateProgress();
		for (const id of ['entry', 'pdf', 'categorize', 'approve', 'skip', 'retry']) $(id).disabled = false;
		$('send').disabled = !!job && job.status !== 'ready';
		$('produceSummary').disabled = job?.status !== 'ready';
	}
}
$('entry').onclick = () => act('start', {mode: 'entry', requestID});
$('pdf').onclick = () => act('start', {mode: 'pdf', requestID});
$('categorize').onclick = () => act('start', {mode: 'categorize', requestID});
$('close').onclick = () => call('close').catch(error);
$('dock').onclick = () => setPanelMode(panelMode === 'docked' ? 'floating' : 'docked');
$('minimize').onclick = () => setPanelMode('minimized');
$('restore').onclick = () => setPanelMode('docked');
$('ordinary').onclick = () => call('ordinary').then(() => call('close')).catch(error);
$('approve').onclick = () => act('approve', {id: job.id, selected: [...$('proposals').querySelectorAll('input:checked')].map(input => Number(input.value))});
$('skip').onclick = () => act('approve', {id: job.id, selected: []});
$('produceSummary').onclick = () => act('summarize', {id: job.id});
$('retry').onclick = () => act('retry', {id: job.id});
$('chatForm').onsubmit = event => { event.preventDefault(); const question = $('question').value.trim(); if (question) act('chat', {id: job.id, question}); };
$('question').onkeydown = event => {
	if (event.key !== 'Enter' || !event.metaKey || event.isComposing) return;
	event.preventDefault();
	$('send').click();
};
$('categorySearch').oninput = filterCategories;
$('newCategory').onclick = () => showNewCategory($('newCategoryForm').hidden);
$('newCategoryName').oninput = updateNewCategory;
$('newCategoryParent').onchange = updateNewCategory;
$('newCategoryForm').onsubmit = createCategory;
$('cancelNewCategory').onclick = () => { $('newCategoryForm').reset(); showNewCategory(false); $('newCategory').focus(); };
$('categoryPicker').ontoggle = () => { if ($('categoryPicker').open) { showNewCategory(false); $('categorySearch').focus(); } };
document.addEventListener('pointerdown', event => {
	if (!$('categoryPicker').contains(event.target)) $('categoryPicker').open = false;
});
window.addEventListener('blur', () => { $('categoryPicker').open = false; });
document.addEventListener('keydown', event => {
	if (event.key !== 'Escape') return;
	if ($('categoryPicker').open) { $('categoryPicker').open = false; $('categoryPicker').querySelector('summary').focus(); }
	else if (!$('newCategoryForm').hidden) { if (!categoryBusy) { showNewCategory(false); $('newCategory').focus(); } }
	else call('close').catch(error);
});
$('copySession').onclick = async () => {
	try { const result = await call('command', {id: job.id}); $('sessionCommand').textContent = result.command; await navigator.clipboard.writeText(result.command); $('copyStatus').textContent = 'Copied'; }
	catch (e) { $('copyStatus').textContent = e.message; }
};
let lastSize;
function resizePanel() {
	const height = Math.ceil(document.body.getBoundingClientRect().height);
	const expanded = document.body.classList.contains('results');
	const size = `${height}:${expanded}:${panelMode}`;
	if (size === lastSize) return;
	lastSize = size;
	return call('resize', {height, expanded, mode: panelMode});
}
async function setPanelMode(mode) {
	const scrollY = panelMode === 'minimized' ? minimizedScrollY : window.scrollY;
	if (mode === 'minimized') minimizedScrollY = scrollY;
	panelMode = mode;
	document.body.dataset.mode = mode;
	const minimized = mode === 'minimized';
	$('panelHeading').hidden = minimized;
	$('restore').hidden = !minimized;
	$('dock').hidden = minimized;
	$('minimize').hidden = mode !== 'docked';
	const dockLabel = mode === 'docked' ? 'Return to centered view' : 'Dock panel';
	$('dock').setAttribute('aria-label', dockLabel);
	$('dock').title = dockLabel;
	try {
		await resizePanel();
		requestAnimationFrame(() => {
			(minimized ? $('restore') : $('dock')).focus({preventScroll: true});
			window.scrollTo(0, minimized ? 0 : scrollY);
		});
	} catch (e) { error(e); }
}
new ResizeObserver(() => { resizePanel()?.catch(console.error); }).observe(document.body);
setInterval(updateActivity, 1000);
refresh(true);
