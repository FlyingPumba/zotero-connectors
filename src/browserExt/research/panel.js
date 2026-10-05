/* global browser */
const $ = id => document.getElementById(id);
let job, busy = false, timer, requestID = crypto.randomUUID(), approvalID, messageSnapshot;
async function call(action, data = {}) {
	const result = await browser.runtime.sendMessage({research: 'panel', action, data});
	if (!result || result.error) throw new Error(result?.error || 'The Connector could not respond. Reload this page and try again.');
	return result;
}
function error(e) { $('error').textContent = e.message; $('error').hidden = false; }
function render(next) {
	job = next;
	$('actions').hidden = !!job;
	$('paper').hidden = !job?.summary;
	$('status').textContent = job ? job.stage : 'Ready';
	$('error').hidden = !job?.error;
	if (job?.error) $('error').textContent = job.error;
	$('retry').hidden = job?.status !== 'error';
	$('approval').hidden = job?.status !== 'awaiting_approval';
	$('chat').hidden = !['ready', 'chatting'].includes(job?.status);
	if (!job) return;
	$('title').textContent = job.title;
	$('summary').textContent = job.summary || '';
	$('coverage').textContent = `${(job.coverage || '').replaceAll('_', ' ')}${job.sourceInfo ? ' · ' + job.sourceInfo.kind : ''}${job.sourceInfo?.warning ? ' · ' + job.sourceInfo.warning : ''}`;
	$('filed').textContent = job.existingCollections?.length ? 'Filed in: ' + job.existingCollections.map(c => c.path).join(' · ') : '';
	if (job.status === 'awaiting_approval' && approvalID !== job.id) {
		approvalID = job.id; $('proposals').replaceChildren();
		job.proposedCollections.forEach((proposal, index) => {
			const label = document.createElement('label'), checkbox = document.createElement('input'), reason = document.createElement('small');
			checkbox.type = 'checkbox'; checkbox.value = index;
			label.append(checkbox, ' ' + (proposal.parentPath ? proposal.parentPath + ' / ' : '') + proposal.name);
			reason.textContent = proposal.reason; label.append(reason); $('proposals').append(label);
		});
	}
	const snapshot = JSON.stringify(job.messages);
	if (snapshot !== messageSnapshot) {
		messageSnapshot = snapshot; $('messages').replaceChildren();
		for (const message of job.messages || []) {
			const block = document.createElement('div'), name = document.createElement('strong');
			block.className = 'message ' + message.role; name.textContent = message.role === 'user' ? 'YOU' : 'PAPER DISCUSSION';
			block.append(name, document.createTextNode(message.text)); $('messages').append(block);
		}
	}
	$('partial').textContent = job.partial || '';
	$('send').disabled = busy || job.status === 'chatting';
	$('question').disabled = job.status === 'chatting';
}
async function refresh() {
	try { const result = await call('status', {id: job?.id}); render(result.job); }
	catch (e) { error(e); }
	clearTimeout(timer);
	if (job && ['ingesting', 'chatting'].includes(job.status)) timer = setTimeout(refresh, 1000);
}
async function act(action, data) {
	if (busy) return;
	busy = true; $('error').hidden = true;
	for (const id of ['entry', 'pdf', 'approve', 'skip', 'retry', 'send']) $(id).disabled = true;
	try {
		$('status').textContent = action === 'start' ? 'Reading metadata and adding entry…' : 'Working…';
		render(await call(action, data));
		if (action === 'chat') $('question').value = '';
		await refresh();
	} catch (e) { error(e); }
	finally {
		busy = false;
		for (const id of ['entry', 'pdf', 'approve', 'skip', 'retry']) $(id).disabled = false;
		$('send').disabled = job?.status === 'chatting';
	}
}
$('entry').onclick = () => act('start', {mode: 'entry', requestID});
$('pdf').onclick = () => act('start', {mode: 'pdf', requestID});
$('close').onclick = () => call('close').catch(error);
$('ordinary').onclick = () => call('ordinary').then(() => call('close')).catch(error);
$('approve').onclick = () => act('approve', {id: job.id, selected: [...$('proposals').querySelectorAll('input:checked')].map(input => Number(input.value))});
$('skip').onclick = () => act('approve', {id: job.id, selected: []});
$('retry').onclick = () => act('retry', {id: job.id});
$('chatForm').onsubmit = event => { event.preventDefault(); const question = $('question').value.trim(); if (question) act('chat', {id: job.id, question}); };
refresh();
