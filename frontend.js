const APP_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxsGA4I2OXwmDNISLNTRx9rDYooIVqCq_hjOPhfwsQo-kWr6Y9VFb3ChDuVEBZ6Z98/exec";

const $ = (id) => document.getElementById(id);
const bridgeFrame = document.createElement('iframe');
const bridgeNonce = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
const bridgePending = new Map();
const bridgeQueue = [];
let bridgeReady = false;
let bridgeRequestNumber = 0;
const BRIDGE_TIMEOUT_MS = 45000;

bridgeFrame.id = 'portalBridge';
bridgeFrame.name = 'teacherMailDeskBridgeTarget';
bridgeFrame.title = 'Secure Apps Script connection';
bridgeFrame.setAttribute('aria-hidden', 'true');
bridgeFrame.src = APP_SCRIPT_URL + '?bridge=1&nonce=' + encodeURIComponent(bridgeNonce);
bridgeFrame.addEventListener('load', () => { bridgeReady = true; flushBridgeQueue(); });
document.body.appendChild(bridgeFrame);

function messageText(error) {
  return String(error && error.message ? error.message : error || 'Request failed.');
}

function flushBridgeQueue() {
  if (!bridgeReady) return;
  while (bridgeQueue.length) {
    const request = bridgeQueue.shift();
    const form = document.createElement('form');
    form.method = 'post';
    form.action = APP_SCRIPT_URL;
    form.target = bridgeFrame.name;
    form.hidden = true;
    [['bridge', '1'], ['requestId', request.id], ['nonce', bridgeNonce], ['method', request.method], ['args', JSON.stringify(request.args)]].forEach(([name, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = name; input.value = value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    HTMLFormElement.prototype.submit.call(form);
    form.remove();
  }
}

function bridgeRpc(method, args) {
  return new Promise((resolve, reject) => {
    const id = 'request-' + (++bridgeRequestNumber);
    bridgePending.set(id, { resolve, reject });
    bridgeQueue.push({ id, method, args: args || [] });
    flushBridgeQueue();
    window.setTimeout(() => {
      const pending = bridgePending.get(id);
      if (!pending) return;
      bridgePending.delete(id);
      pending.reject(new Error('The private Gmail backend did not respond. Try again in a moment.'));
    }, BRIDGE_TIMEOUT_MS);
  });
}

window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.nonce !== bridgeNonce) return;
  if (data.type !== 'teacher-mail-desk:response') return;
  const pending = bridgePending.get(data.requestId);
  if (!pending) return;
  bridgePending.delete(data.requestId);
  if (data.ok) pending.resolve(data.result);
  else pending.reject(new Error(data.error || 'Request failed.'));
  $('connectionStatus').textContent = 'Secure backend connected';
});

let currentThreads = [];
let currentAllowedSenders = [];
let activeFolder = 'all';
let selectedThreadId = '';
let selectedMessageId = '';
let portalSessionToken = '';
let mailboxLoadInFlight = false;
let conversationRequestNumber = 0;
let remoteConversationRequestNumber = 0;

function showAlert(message, type = 'error') {
  const container = $('alertContainer');
  container.textContent = '';
  if (!message) return;
  const alert = document.createElement('div');
  alert.className = 'alert alert-' + type;
  alert.textContent = message;
  container.appendChild(alert);
}

function showLogin() {
  $('loginForm').classList.remove('hidden');
  $('registerForm').classList.add('hidden');
}

function showRegister() {
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
}

function showDashboard() {
  document.body.classList.add('mailbox-open');
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.add('hidden');
  $('dashboardContainer').classList.remove('hidden');
  $('statusLabel').textContent = 'Loading managed conversations…';
  loadThreads();
}

function hideDashboard() {
  document.body.classList.remove('mailbox-open');
  $('dashboardContainer').classList.add('hidden');
  $('loginForm').classList.remove('hidden');
  $('registerForm').classList.add('hidden');
  currentThreads = [];
  currentAllowedSenders = [];
  activeFolder = 'all';
  selectedThreadId = '';
  selectedMessageId = '';
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
    button.textContent = label || 'Working…';
  } else {
    if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  }
}

function readAttachments(input) {
  const files = Array.from(input.files || []);
  if (files.length > 5) return Promise.reject(new Error('Attach no more than 5 files per message.'));
  if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {
    return Promise.reject(new Error('Attachments are limited to 20 MB total per message.'));
  }
  return Promise.all(files.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', base64: value.includes(',') ? value.split(',')[1] : value });
    };
    reader.onerror = () => reject(new Error('A selected file could not be read.'));
    reader.readAsDataURL(file);
  })));
}

function updateFolderCounts() {
  $('allCount').textContent = currentThreads.length;
  $('inboxCount').textContent = currentThreads.filter((thread) => thread.hasInbound).length;
  $('sentCount').textContent = currentThreads.filter((thread) => thread.hasSent).length;
}

function uniqueThreads(threads) {
  const seen = new Set();
  return (threads || []).filter((thread) => {
    const id = String(thread && thread.threadId || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function setFolder(folder) {
  activeFolder = folder;
  document.querySelectorAll('[data-folder]').forEach((button) => {
    button.classList.toggle('active', button.dataset.folder === folder);
  });
  $('folderTitle').textContent = folder === 'inbox' ? 'Inbox' : folder === 'sent' ? 'Sent' : 'All mail';
  renderThreads();
}

function threadMatchesFolder(thread) {
  if (activeFolder === 'inbox') return Boolean(thread.hasInbound);
  if (activeFolder === 'sent') return Boolean(thread.hasSent);
  return true;
}

function renderAllowedSenders() {
  const list = $('allowedSendersList');
  list.textContent = '';
  if (!currentAllowedSenders.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No approved senders yet. Send a message to add its recipient automatically, or add an address in the AllowedSenders Sheet tab.';
    list.appendChild(empty);
    return;
  }
  currentAllowedSenders.forEach((email) => {
    const row = document.createElement('div');
    row.className = 'allowed-row';
    const dot = document.createElement('span');
    dot.className = 'allowed-dot';
    const address = document.createElement('span');
    address.textContent = email;
    row.append(dot, address);
    list.appendChild(row);
  });
}

function renderThreads() {
  const list = $('threadList');
  list.textContent = '';
  const threads = currentThreads.filter(threadMatchesFolder);
  if (!threads.length) {
    const empty = document.createElement('div');
    empty.className = 'empty mailbox-empty';
    empty.textContent = activeFolder === 'inbox'
      ? 'Your inbox is empty. Approved senders will appear here when they email the managed Gmail account.'
      : activeFolder === 'sent'
        ? 'No sent conversations yet. Use Compose to send the first message.'
        : 'No mail yet. Use Compose to start a managed conversation.';
    list.appendChild(empty);
    $('noThread').classList.remove('hidden');
    return;
  }
  $('noThread').classList.add('hidden');
  threads.forEach((thread) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thread-row' + (thread.threadId === selectedThreadId ? ' active' : '');
    button.addEventListener('click', () => selectThread(thread.threadId));
    const sender = document.createElement('strong');
    sender.className = 'thread-sender';
    sender.textContent = thread.sender || thread.recipient || 'Managed conversation';
    const subject = document.createElement('span');
    subject.className = 'thread-subject';
    subject.textContent = thread.subject || 'Private conversation';
    const preview = document.createElement('span');
    preview.className = 'thread-preview';
    preview.textContent = thread.preview || '';
    const date = document.createElement('time');
    date.className = 'thread-date';
    date.textContent = thread.lastMessageAt ? new Date(thread.lastMessageAt).toLocaleDateString() : '';
    const copy = document.createElement('span');
    copy.className = 'thread-copy';
    copy.append(subject, preview);
    button.append(sender, copy, date);
    list.appendChild(button);
  });
}

function prepareForward(threadId, messageId) {
  selectedMessageId = messageId;
  $('forwardThreadId').value = threadId;
  $('forwardMessageId').value = messageId;
  $('forwardForm').classList.remove('hidden');
  $('forwardTo').focus();
  $('forwardForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function formatMessageDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function appendDetailRow(container, label, value) {
  if (!value) return;
  const row = document.createElement('div');
  row.className = 'message-detail-row';
  const key = document.createElement('span');
  key.className = 'message-detail-label';
  key.textContent = label;
  const text = document.createElement('span');
  text.className = 'message-detail-value';
  text.textContent = value;
  row.append(key, text);
  container.appendChild(row);
}

function downloadReceivedAttachment(threadId, messageId, file, button) {
  setBusy(button, true, 'Downloading…');
  authenticatedRpc('downloadAttachment', [threadId, messageId, file.attachmentId, file.name]).then((result) => {
    const binary = atob(String(result && result.base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.name || file.name || 'received-file';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showAlert('File downloaded.', 'success');
  }).catch((error) => showAlert(messageText(error))).finally(() => setBusy(button, false));
}

function renderThread(thread) {
  if (!thread) return;
  renderThreads();
  $('noThread').classList.add('hidden');
  $('threadPanel').classList.remove('hidden');
  $('threadSubject').textContent = thread.subject || 'Private conversation';
  $('threadRecipient').textContent = (thread.messageCount || (thread.messages || []).length || 1) + ' message' + ((thread.messageCount || (thread.messages || []).length || 1) === 1 ? '' : 's') + ' · Conversation with ' + (thread.recipient || 'managed recipient');
  const list = $('messageList');
  list.textContent = '';
  (thread.messages || []).forEach((message) => {
    const card = document.createElement('article');
    card.className = 'message' + (message.mine ? ' mine' : '') + (message.blocked ? ' blocked-message' : '');
    if (message.blocked) {
      card.textContent = 'This message is hidden by the privacy filter. Attachments and suspected financial/account content are never shown or forwarded.';
    } else {
      const header = document.createElement('div');
      header.className = 'message-header';
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = (message.mine ? 'Y' : (message.fromName || message.from || 'S')).trim().slice(0, 1).toUpperCase();
      const identity = document.createElement('div');
      identity.className = 'message-identity';
      const senderLine = document.createElement('div');
      senderLine.className = 'message-sender-line';
      const sender = document.createElement('strong');
      sender.textContent = message.mine ? 'You' : (message.fromName || message.from || 'Sender hidden');
      senderLine.appendChild(sender);
      const email = document.createElement('span');
      email.className = 'message-email';
      email.textContent = message.from || '';
      senderLine.appendChild(email);
      identity.appendChild(senderLine);
      const summary = document.createElement('span');
      summary.className = 'message-recipient-summary';
      summary.textContent = message.mine ? 'to ' + (message.to || thread.recipient || 'recipient') : 'to me';
      identity.appendChild(summary);
      const dateBlock = document.createElement('div');
      dateBlock.className = 'message-date-block';
      const date = document.createElement('time');
      date.dateTime = message.date || '';
      date.textContent = formatMessageDate(message.date);
      dateBlock.appendChild(date);
      const detailsButton = document.createElement('button');
      detailsButton.type = 'button';
      detailsButton.className = 'message-detail-toggle';
      detailsButton.textContent = 'Show details';
      dateBlock.appendChild(detailsButton);
      header.append(avatar, identity, dateBlock);
      const details = document.createElement('div');
      details.className = 'message-details hidden';
      appendDetailRow(details, 'From', message.fromName && message.from ? message.fromName + ' <' + message.from + '>' : (message.from || 'Sender hidden'));
      appendDetailRow(details, 'To', message.to || thread.recipient || 'Managed mailbox');
      appendDetailRow(details, 'Cc', message.cc);
      appendDetailRow(details, 'Reply-To', message.replyTo);
      appendDetailRow(details, 'Date', formatMessageDate(message.date) || message.date);
      detailsButton.addEventListener('click', () => {
        const expanded = !details.classList.contains('hidden');
        details.classList.toggle('hidden', expanded);
        detailsButton.textContent = expanded ? 'Show details' : 'Hide details';
      });
      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = message.body || '';
      card.append(header, details, body);
      if (message.attachments && message.attachments.length) {
        const attachments = document.createElement('div');
        attachments.className = 'message-attachment-list';
        message.attachments.forEach((file) => {
          const chip = document.createElement(file.attachmentId ? 'button' : 'span');
          chip.className = 'attachment-chip';
          if (file.attachmentId) {
            chip.type = 'button';
            chip.title = 'Download received file';
            chip.addEventListener('click', () => downloadReceivedAttachment(thread.threadId, message.id, file, chip));
          }
          chip.textContent = file.name + (file.size ? ' · ' + Math.ceil(file.size / 1024) + ' KB' : '');
          attachments.appendChild(chip);
        });
        card.appendChild(attachments);
      } else if (message.attachment) {
        const attachmentNote = document.createElement('div');
        attachmentNote.className = 'message-attachment-note';
        attachmentNote.textContent = 'Attachment present. File contents stay in the managed Gmail account.';
        card.appendChild(attachmentNote);
      }
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      if (!message.mine) {
        const reply = document.createElement('button');
        reply.type = 'button';
        reply.className = 'button button-secondary button-small';
        reply.textContent = 'Reply';
        reply.addEventListener('click', () => {
          $('replyBody').focus();
          $('replyForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        actions.appendChild(reply);
      }
      const forward = document.createElement('button');
      forward.type = 'button';
      forward.className = 'button button-secondary button-small';
      forward.textContent = 'Forward';
      forward.addEventListener('click', () => prepareForward(thread.threadId, message.id));
      actions.appendChild(forward);
      card.append(actions);
    }
    list.appendChild(card);
  });
  if (!(thread.messages || []).length) {
    const pending = document.createElement('div');
    pending.className = 'conversation-loading';
    pending.textContent = thread.needsRemoteCheck ? 'Checking the managed Gmail conversation for received messages…' : 'No visible message content is available.';
    list.appendChild(pending);
  }
}

function selectThread(id) {
  selectedThreadId = id;
  const thread = currentThreads.find((item) => item.threadId === id);
  if (!thread) return;
  renderThreads();
  $('noThread').classList.add('hidden');
  $('threadPanel').classList.remove('hidden');
  $('threadSubject').textContent = thread.subject || 'Conversation';
  $('threadRecipient').textContent = 'Loading complete conversation…';
  $('messageList').textContent = '';
  const loading = document.createElement('div');
  loading.className = 'conversation-loading';
  loading.textContent = 'Loading message details…';
  $('messageList').appendChild(loading);
  const requestNumber = ++conversationRequestNumber;
  authenticatedRpc('getManagedThread', [id]).then((result) => {
    if (requestNumber !== conversationRequestNumber || selectedThreadId !== id) return;
    const loaded = result && result.thread ? result.thread : result;
    if (!loaded) throw new Error('The conversation was empty.');
    const index = currentThreads.findIndex((item) => item.threadId === id);
    if (index >= 0) currentThreads[index] = loaded;
    showAlert('');
    renderThread(loaded);
    updateFolderCounts();
    if (loaded.needsRemoteCheck) {
      const remoteRequestNumber = ++remoteConversationRequestNumber;
      authenticatedRpc('getManagedThreadRemote', [id]).then((remoteResult) => {
        if (remoteRequestNumber !== remoteConversationRequestNumber || selectedThreadId !== id) return;
        const remoteThread = remoteResult && remoteResult.thread ? remoteResult.thread : remoteResult;
        if (!remoteThread) return;
        const remoteIndex = currentThreads.findIndex((item) => item.threadId === id);
        if (remoteIndex >= 0) currentThreads[remoteIndex] = remoteThread;
        if (!$('replyBody').value.trim()) renderThread(remoteThread);
        updateFolderCounts();
      }).catch(() => {
        // The audited copy stays readable if Gmail is temporarily slow.
      });
    }
  }).catch((error) => {
    if (requestNumber !== conversationRequestNumber || selectedThreadId !== id) return;
    $('messageList').textContent = '';
    const failed = document.createElement('div');
    failed.className = 'empty';
    failed.textContent = 'This conversation could not be loaded. Tap Refresh to try again.';
    $('messageList').appendChild(failed);
    showAlert(messageText(error));
  });
}

function loadThreads() {
  if (mailboxLoadInFlight) return;
  mailboxLoadInFlight = true;
  $('statusLabel').textContent = 'Loading managed conversations…';
  authenticatedRpc('listManagedThreads', []).then((result) => {
    showAlert('');
    currentThreads = uniqueThreads(result && result.threads ? result.threads : []);
    currentAllowedSenders = result && result.allowedSenders ? result.allowedSenders : [];
    $('statusLabel').textContent = currentThreads.length + ' conversation' + (currentThreads.length === 1 ? '' : 's');
    updateFolderCounts();
    renderAllowedSenders();
    renderThreads();
    if (selectedThreadId) selectThread(selectedThreadId);
  }).catch((error) => {
    $('statusLabel').textContent = '';
    const list = $('threadList');
    list.textContent = '';
    const failed = document.createElement('div');
    failed.className = 'empty';
    failed.textContent = 'Mailbox could not be loaded. Tap Refresh to try again.';
    list.appendChild(failed);
    $('allowedSendersList').textContent = '';
    showAlert(messageText(error));
  }).finally(() => {
    mailboxLoadInFlight = false;
  });
}

function openCompose() {
  $('composeForm').classList.remove('hidden');
  $('composeTo').focus();
}

function closeCompose() {
  $('composeForm').classList.add('hidden');
}

function closeThread() {
  selectedThreadId = '';
  selectedMessageId = '';
  $('threadPanel').classList.add('hidden');
  $('forwardForm').classList.add('hidden');
  renderThreads();
}

function authenticatedRpc(method, args) {
  if (!portalSessionToken) return Promise.reject(new Error('Sign in to the teacher portal first.'));
  return bridgeRpc(method, [portalSessionToken].concat(args || []));
}

function submitAccount(form, method, accountId, passwordId, codeId, buttonLabel) {
  const button = $(method === 'signIn' ? 'loginButton' : 'registerButton');
  setBusy(button, true, buttonLabel);
  showAlert('');
  bridgeRpc(method, [$(accountId).value, $(passwordId).value, $(codeId).value]).then((result) => {
    portalSessionToken = result && result.sessionToken ? result.sessionToken : '';
    if (!portalSessionToken) throw new Error('The secure portal did not return a session.');
    setBusy(button, false);
    if (form) form.reset();
    showDashboard();
  }).catch((error) => {
    setBusy(button, false);
    showAlert(messageText(error));
  });
}

function handleSend(form, method, args, successMessage, buttonLabel) {
  const button = $({ sendMessage: 'composeButton', replyToThread: 'replyButton', forwardMessage: 'forwardButton' }[method]);
  setBusy(button, true, buttonLabel);
  showAlert('');
  authenticatedRpc(method, args).then(() => {
    setBusy(button, false);
    if (form) form.reset();
    if (method === 'sendMessage') {
      closeCompose();
      setFolder('sent');
    }
    showAlert(successMessage, 'success');
    loadThreads();
  }).catch((error) => {
    setBusy(button, false);
    showAlert(messageText(error));
  });
}

function showState(state) {
  if (!state || !state.ok) {
    showAlert((state && state.message) || 'Authorize the teacher Google account, then try again.');
    return;
  }
  if (state.authenticated) showDashboard();
  else if (!state.registered) showRegister();
}

$('showRegisterBtn').addEventListener('click', showRegister);
$('showLoginBtn').addEventListener('click', showLogin);
$('loginButton').addEventListener('click', () => {
  submitAccount($('loginForm'), 'signIn', 'loginAccountName', 'loginPassword', 'loginAccessCode', 'Signing in…');
});
$('registerButton').addEventListener('click', () => {
  submitAccount($('registerForm'), 'signUp', 'registerAccountName', 'registerPassword', 'registerAccessCode', 'Creating account…');
});
$('loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitAccount(event.currentTarget, 'signIn', 'loginAccountName', 'loginPassword', 'loginAccessCode', 'Signing in…');
});
$('registerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitAccount(event.currentTarget, 'signUp', 'registerAccountName', 'registerPassword', 'registerAccessCode', 'Creating account…');
});
$('composeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('composeButton');
  setBusy(button, true, 'Sending…');
  try {
    const attachments = await readAttachments($('composeFiles'));
    handleSend(form, 'sendMessage', [$('composeTo').value, $('composeSubject').value, $('composeBody').value, attachments], 'Message sent. It is now a managed conversation.', 'Sending…');
  } catch (error) { setBusy(button, false); showAlert(messageText(error)); }
});
$('replyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('replyButton');
  setBusy(button, true, 'Sending reply…');
  try {
    const attachments = await readAttachments($('replyFiles'));
    handleSend(form, 'replyToThread', [selectedThreadId, $('replyBody').value, attachments], 'Reply sent through the managed Gmail backend.', 'Sending reply…');
  } catch (error) { setBusy(button, false); showAlert(messageText(error)); }
});
$('forwardForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('forwardButton');
  setBusy(button, true, 'Forwarding…');
  try {
    const attachments = await readAttachments($('forwardFiles'));
    handleSend(form, 'forwardMessage', [$('forwardThreadId').value, $('forwardMessageId').value, $('forwardTo').value, $('forwardNote').value, attachments], 'Forward sent through the managed Gmail backend.', 'Forwarding…');
  } catch (error) { setBusy(button, false); showAlert(messageText(error)); }
});
$('composeOpenButton').addEventListener('click', openCompose);
$('composeCloseButton').addEventListener('click', closeCompose);
$('closeThreadButton').addEventListener('click', closeThread);
document.querySelectorAll('[data-folder]').forEach((button) => {
  button.addEventListener('click', () => setFolder(button.dataset.folder));
});
$('refreshButton').addEventListener('click', loadThreads);
$('signoutButton').addEventListener('click', () => {
  authenticatedRpc('signOut', []).then(() => {
    portalSessionToken = '';
    hideDashboard();
    showAlert('You have been signed out.', 'success');
  }).catch((error) => showAlert(messageText(error)));
});

showLogin();
