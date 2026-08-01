const APP_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxsGA4I2OXwmDNISLNTRx9rDYooIVqCq_hjOPhfwsQo-kWr6Y9VFb3ChDuVEBZ6Z98/exec";

const $ = (id) => document.getElementById(id);
const bridgeFrame = document.createElement('iframe');
const bridgeNonce = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
const bridgePending = new Map();
const bridgeQueue = [];
let bridgeReady = false;
let bridgeRequestNumber = 0;
const BRIDGE_TIMEOUT_MS = 90000;

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
let selectedThreadId = '';
let selectedMessageId = '';
let portalSessionToken = '';

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
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.add('hidden');
  $('dashboardContainer').classList.remove('hidden');
  $('statusLabel').textContent = 'Connecting to managed Gmail…';
  authenticatedRpc('setupMailbox', []).then(loadThreads).catch((error) => showAlert(messageText(error)));
}

function hideDashboard() {
  $('dashboardContainer').classList.add('hidden');
  $('loginForm').classList.remove('hidden');
  $('registerForm').classList.add('hidden');
  currentThreads = [];
  selectedThreadId = '';
  selectedMessageId = '';
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label || 'Working…';
  } else if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
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

function renderThreads() {
  const list = $('threadList');
  list.textContent = '';
  if (!currentThreads.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No portal-created conversations yet. Use the message form to start one.';
    list.appendChild(empty);
    return;
  }
  currentThreads.forEach((thread) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thread-button' + (thread.threadId === selectedThreadId ? ' active' : '');
    button.addEventListener('click', () => selectThread(thread.threadId));
    const title = document.createElement('strong');
    title.textContent = thread.subject || 'Private conversation';
    const preview = document.createElement('span');
    preview.textContent = thread.preview || thread.recipient || '';
    button.append(title, preview);
    list.appendChild(button);
  });
}

function prepareForward(threadId, messageId) {
  selectedMessageId = messageId;
  $('forwardThreadId').value = threadId;
  $('forwardMessageId').value = messageId;
  $('forwardCard').classList.remove('hidden');
  $('forwardTo').focus();
  $('forwardCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectThread(id) {
  selectedThreadId = id;
  const thread = currentThreads.find((item) => item.threadId === id);
  if (!thread) return;
  renderThreads();
  $('noThread').classList.add('hidden');
  $('threadPanel').classList.remove('hidden');
  $('threadSubject').textContent = thread.subject || 'Private conversation';
  $('threadRecipient').textContent = 'Conversation with ' + (thread.recipient || 'managed recipient');
  const list = $('messageList');
  list.textContent = '';
  (thread.messages || []).forEach((message) => {
    const card = document.createElement('article');
    card.className = 'message' + (message.mine ? ' mine' : '') + (message.blocked ? ' blocked-message' : '');
    if (message.blocked) {
      card.textContent = 'This message is hidden by the privacy filter. Attachments and suspected financial/account content are never shown or forwarded.';
    } else {
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const from = document.createElement('span');
      from.textContent = message.mine ? 'Sent by teacher portal' : (message.from || 'Sender hidden');
      const date = document.createElement('span');
      date.textContent = message.date || '';
      meta.append(from, date);
      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = message.body || '';
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      const forward = document.createElement('button');
      forward.type = 'button';
      forward.className = 'button button-secondary button-small';
      forward.textContent = 'Forward';
      forward.addEventListener('click', () => prepareForward(thread.threadId, message.id));
      actions.appendChild(forward);
      card.append(meta, body, actions);
    }
    list.appendChild(card);
  });
}

function loadThreads() {
  $('statusLabel').textContent = 'Loading managed conversations…';
  authenticatedRpc('listManagedThreads', []).then((result) => {
    currentThreads = result && result.threads ? result.threads : [];
    $('statusLabel').textContent = currentThreads.length + ' managed thread' + (currentThreads.length === 1 ? '' : 's');
    renderThreads();
    if (selectedThreadId) selectThread(selectedThreadId);
  }).catch((error) => {
    $('statusLabel').textContent = '';
    showAlert(messageText(error));
  });
}

function authenticatedRpc(method, args) {
  if (!portalSessionToken) return Promise.reject(new Error('Sign in to the teacher portal first.'));
  return bridgeRpc(method, [portalSessionToken].concat(args || []));
}

function submitAccount(form, method, accountId, passwordId, codeId, buttonLabel) {
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, buttonLabel);
  showAlert('');
  bridgeRpc(method, [$(accountId).value, $(passwordId).value, $(codeId).value]).then((result) => {
    portalSessionToken = result && result.sessionToken ? result.sessionToken : '';
    if (!portalSessionToken) throw new Error('The secure portal did not return a session.');
    setBusy(button, false);
    form.reset();
    showDashboard();
  }).catch((error) => {
    setBusy(button, false);
    showAlert(messageText(error));
  });
}

function handleSend(form, method, args, successMessage, buttonLabel) {
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, buttonLabel);
  showAlert('');
  authenticatedRpc(method, args).then(() => {
    setBusy(button, false);
    form.reset();
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
  try {
    const attachments = await readAttachments($('composeFiles'));
    handleSend(form, 'sendMessage', [$('composeTo').value, $('composeSubject').value, $('composeBody').value, attachments], 'Message sent. It is now a managed conversation.', 'Sending…');
  } catch (error) { showAlert(messageText(error)); }
});
$('replyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const attachments = await readAttachments($('replyFiles'));
    handleSend(form, 'replyToThread', [selectedThreadId, $('replyBody').value, attachments], 'Reply sent through the managed Gmail backend.', 'Sending reply…');
  } catch (error) { showAlert(messageText(error)); }
});
$('forwardForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const attachments = await readAttachments($('forwardFiles'));
    handleSend(form, 'forwardMessage', [$('forwardThreadId').value, $('forwardMessageId').value, $('forwardTo').value, $('forwardNote').value, attachments], 'Forward sent through the managed Gmail backend.', 'Forwarding…');
  } catch (error) { showAlert(messageText(error)); }
});
$('refreshButton').addEventListener('click', loadThreads);
$('signoutButton').addEventListener('click', () => {
  authenticatedRpc('signOut', []).then(() => {
    portalSessionToken = '';
    hideDashboard();
    showAlert('You have been signed out.', 'success');
  }).catch((error) => showAlert(messageText(error)));
});

bridgeRpc('getAppState', []).then(showState).catch((error) => showAlert(messageText(error)));
