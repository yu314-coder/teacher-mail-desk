/**
 * Teacher Mail Desk portal.
 *
 * Deploy this project as a web app executing as USER_ACCESSING. The teacher
 * must authorize the Gmail scopes for their own Google account. The GitHub
 * Pages shell only embeds this app; it never receives Gmail tokens.
 */

const PORTAL = {
  labelName: 'TeacherPortal/Managed',
  maxThreads: 40,
  maxBodyChars: 60000,
  maxAttachmentBytes: 20 * 1024 * 1024,
  auditForwardTo: 'imadmitted@gmail.com',
  sessionProperty: 'PORTAL_SESSION_TOKEN',
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Teacher Mail Desk')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Accepts the GitHub Pages login/register form without exposing credentials
 * to GitHub or a browser cross-origin API. The form is HTTPS POSTed directly
 * to this web app, then the teacher is redirected into the Apps Script UI.
 */
function doPost(e) {
  try {
    const parameters = e && e.parameter ? e.parameter : {};
    activeEmail_();

    const action = String(parameters.action || '').trim().toLowerCase();
    if (action === 'signin') {
      signIn(parameters.accountName, parameters.password, parameters.accessCode);
      return postRedirect_('signin');
    }
    if (action === 'signup') {
      signUp(parameters.accountName, parameters.password, parameters.accessCode);
      return postRedirect_('signup');
    }
    throw new Error('Unknown account action.');
  } catch (error) {
    return postResult_('Teacher account', publicError_(error), false);
  }
}

function postRedirect_(mode) {
  const destination = ScriptApp.getService().getUrl() + '?mode=' + encodeURIComponent(mode);
  return postResult_('Account verified', 'Opening the secure teacher mailbox…', true, destination);
}

function postResult_(title, message, success, destination) {
  const safeTitle = escapeHtml_(title);
  const safeMessage = escapeHtml_(message);
  const safeDestination = destination ? escapeHtml_(destination) : '';
  const redirectScript = destination ? '<script>window.top.location.replace(' + JSON.stringify(destination) + ');</script>' : '';
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font:16px system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:24px;color:#24342b}' +
    '.card{padding:28px;border:1px solid #dce8e0;border-radius:16px;box-shadow:0 10px 30px #183f2618}' +
    '.ok{color:#236b4d}.bad{color:#a43d3d}a{color:#236b4d}</style></head><body><main class="card">' +
    '<h1 class="' + (success ? 'ok' : 'bad') + '">' + safeTitle + '</h1><p>' + safeMessage + '</p>' +
    (destination ? '<p><a href="' + safeDestination + '">Continue</a></p>' : '<p><a href="' + escapeHtml_(ScriptApp.getService().getUrl()) + '">Return to account sign-in</a></p>') +
    '</main>' + redirectScript + '</body></html>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function escapeHtml_(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function getAppState() {
  const email = activeEmail_();
  if (!email) return { ok: false, code: 'GOOGLE_AUTH_REQUIRED', message: 'Sign in to the teacher Google account before opening the portal.' };
  try {
    const registration = loggerCall_('sessionState', { email });
    const token = userProperties_().getProperty(PORTAL.sessionProperty);
    let authenticated = false;
    if (token) {
      try {
        loggerCall_('authorize', { email, sessionToken: token });
        authenticated = true;
      } catch (ignored) {
        userProperties_().deleteProperty(PORTAL.sessionProperty);
      }
    }
    return { ok: true, email, registered: Boolean(registration.registered), authenticated };
  } catch (error) {
    return { ok: false, code: 'PORTAL_SETUP_REQUIRED', message: publicError_(error) };
  }
}

function signUp(accountName, password, accessCode) {
  const email = activeEmail_();
  validateAccountInputs_(accountName, password, accessCode);
  const result = loggerCall_('register', { email, accountName, password, accessCode });
  saveSession_(result.sessionToken);
  return { ok: true, email, expiresAt: result.expiresAt };
}

function signIn(accountName, password, accessCode) {
  const email = activeEmail_();
  if (!String(accountName || '').trim()) throw new Error('Enter the account name.');
  if (!password || String(password).length < 6) throw new Error('Use a password with at least 6 characters.');
  if (!accessCode || String(accessCode).length < 4) throw new Error('Enter the administrator access code.');
  const result = loggerCall_('login', { email, accountName: String(accountName), password: String(password), accessCode: String(accessCode) });
  saveSession_(result.sessionToken);
  return { ok: true, email, expiresAt: result.expiresAt };
}

function signOut() {
  userProperties_().deleteProperty(PORTAL.sessionProperty);
  return { ok: true };
}

function listManagedThreads() {
  const email = requireSession_();
  const allowed = loggerCall_('listThreads', { email }).slice(0, PORTAL.maxThreads);
  ensureManagedLabel_();
  const result = [];
  allowed.forEach((record) => {
    try {
      const thread = Gmail.Users.Threads.get('me', record.threadId, { format: 'full' });
      const view = threadView_(thread, email, record);
      result.push(view);
      (view.messages || []).filter((message) => !message.blocked && message.body).forEach((message) => {
        recordMessageAudit_(email, 'received', 'view', record.threadId, message.id, message.from, email, message.subject, message.body, []);
      });
    } catch (error) {
      // A deleted or inaccessible thread remains in the audit log but is not
      // allowed to break the rest of the inbox.
      recordAudit_(email, 'read_thread', record.threadId, '', 'error', 'Gmail thread unavailable');
    }
  });
  return { ok: true, threads: result };
}

function sendMessage(to, subject, body, attachments) {
  const email = requireSession_();
  const recipients = parseRecipients_(to);
  const cleanSubject = cleanText_(subject, 180);
  const cleanBody = cleanText_(body, PORTAL.maxBodyChars);
  const safeAttachments = normalizeAttachments_(attachments);
  if (!cleanSubject) throw new Error('Add a subject.');
  if (!cleanBody) throw new Error('Write a message before sending.');
  assertSafeContent_(cleanSubject + '\n' + cleanBody);

  const sent = Gmail.Users.Messages.send({ raw: rawMessage_(recipients, cleanSubject, cleanBody, [], safeAttachments) }, 'me');
  if (!sent || !sent.threadId) throw new Error('Gmail did not return a thread ID.');
  ensureManagedLabel_();
  addManagedLabel_(sent.threadId);
  loggerCall_('recordThread', { email, threadId: sent.threadId, recipient: recipients.join(', ') });
  recordAudit_(email, 'send', sent.threadId, sent.id || '', 'success', '');
  recordMessageAudit_(email, 'sent', 'send', sent.threadId, sent.id || '', email, recipients.join(', '), cleanSubject, cleanBody, safeAttachments);
  forwardAuditCopy_(email, recipients, cleanSubject, cleanBody, sent, safeAttachments);
  return { ok: true, sent: true };
}

function replyToThread(threadId, body, attachments) {
  const email = requireSession_();
  const allowed = allowedThreadMap_(email);
  const id = cleanText_(threadId, 160);
  const record = allowed[id];
  if (!record) throw new Error('That conversation was not started through this portal.');
  const cleanBody = cleanText_(body, PORTAL.maxBodyChars);
  const safeAttachments = normalizeAttachments_(attachments);
  if (!cleanBody) throw new Error('Write a reply before sending.');
  assertSafeContent_(cleanBody);

  const thread = Gmail.Users.Threads.get('me', id, { format: 'full' });
  const inbound = latestInbound_(thread, email);
  const recipient = inbound ? addressFrom_(header_(inbound, 'From')) : record.recipient.split(',')[0].trim();
  if (!recipient || !isEmail_(recipient)) throw new Error('No safe reply recipient was found.');
  const source = inbound || (thread.messages || []).slice(-1)[0];
  const sourceSubject = header_(source, 'Subject') || 'Teacher Mail Desk conversation';
  const replySubject = /^re:/i.test(sourceSubject) ? sourceSubject : 'Re: ' + sourceSubject;
  const messageHeaders = [];
  const messageId = header_(source, 'Message-ID');
  if (messageId) messageHeaders.push('In-Reply-To: ' + messageId, 'References: ' + messageId);

  const sent = Gmail.Users.Messages.send({
    raw: rawMessage_([recipient], replySubject, cleanBody, messageHeaders, safeAttachments),
    threadId: id,
  }, 'me');
  addManagedLabel_(id);
  loggerCall_('recordThread', { email, threadId: id, recipient: record.recipient });
  recordAudit_(email, 'reply', id, sent && sent.id ? sent.id : '', 'success', '');
  recordMessageAudit_(email, 'sent', 'reply', id, sent && sent.id ? sent.id : '', email, recipient, replySubject, cleanBody, safeAttachments);
  forwardAuditCopy_(email, [recipient], replySubject, cleanBody, sent, safeAttachments);
  return { ok: true, sent: true };
}

function setupMailbox() {
  requireSession_();
  ensureManagedLabel_();
  return { ok: true, label: PORTAL.labelName };
}

function requireSession_() {
  const email = activeEmail_();
  const token = userProperties_().getProperty(PORTAL.sessionProperty);
  if (!token) throw new Error('Sign in to the teacher portal first.');
  loggerCall_('authorize', { email, sessionToken: token });
  return email;
}

function loggerCall_(operation, payload) {
  const props = PropertiesService.getScriptProperties();
  const url = String(props.getProperty('LOGGER_URL') || '').trim();
  const secret = String(props.getProperty('LOGGER_SECRET') || '').trim();
  if (!url || !secret) throw new Error('The portal is not connected to its private Sheet logger yet.');
  const body = Object.assign({}, payload || {}, { operation, secret });
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  let decoded;
  try { decoded = JSON.parse(response.getContentText()); } catch (error) { throw new Error('The private Sheet logger returned an invalid response.'); }
  if (response.getResponseCode() >= 300 || !decoded.ok) throw new Error(decoded.error || 'The private Sheet logger rejected the request.');
  return decoded.result;
}

function recordAudit_(email, action, threadId, messageId, result, reason) {
  try {
    loggerCall_('audit', { email, action, threadId, messageId, result, reason });
  } catch (ignored) {
    // Do not turn a successful Gmail operation into a duplicate send because
    // an audit write was temporarily unavailable.
  }
}

function recordMessageAudit_(email, direction, action, threadId, messageId, from, to, subject, body, attachments) {
  if (!messageId) return;
  const attachmentMetadata = (attachments || [])
    .map((file) => ({ name: file.name, mimeType: file.mimeType, size: file.size }))
    .map(JSON.stringify)
    .join('\n');
  try {
    loggerCall_('messageAudit', {
      email, direction, action, threadId, messageId, from, to, subject, body, attachmentMetadata, result: 'success',
    });
  } catch (ignored) {
    // Message delivery/read access remains independent of a temporary audit-write outage.
  }
}

function forwardAuditCopy_(email, recipients, subject, body, sent, attachments) {
  const attachmentSummary = attachments && attachments.length
    ? attachments.map((file) => '- ' + file.name + ' (' + file.size + ' bytes; attachment content omitted)').join('\n')
    : '- None';
  const auditSubject = '[Teacher Mail Desk] ' + subject;
  const auditBody = [
    'Portal sent-email audit copy',
    'From Google account: ' + email,
    'Original recipients: ' + recipients.join(', '),
    'Original subject: ' + subject,
    'Gmail thread ID: ' + (sent && sent.threadId ? sent.threadId : 'not returned'),
    'Gmail message ID: ' + (sent && sent.id ? sent.id : 'not returned'),
    'Attachment metadata:',
    attachmentSummary,
    '',
    'Original plain-text message:',
    body,
  ].join('\n');
  try {
    const forwarded = Gmail.Users.Messages.send({ raw: rawMessage_([PORTAL.auditForwardTo], auditSubject, auditBody) }, 'me');
    recordAudit_(email, 'audit_forward', sent && sent.threadId ? sent.threadId : '', forwarded && forwarded.id ? forwarded.id : '', 'success', PORTAL.auditForwardTo);
  } catch (error) {
    recordAudit_(email, 'audit_forward', sent && sent.threadId ? sent.threadId : '', '', 'error', 'Audit copy failed');
  }
}

function allowedThreadMap_(email) {
  const records = loggerCall_('listThreads', { email });
  return records.reduce((map, record) => { map[record.threadId] = record; return map; }, {});
}

function ensureManagedLabel_() {
  const labels = Gmail.Users.Labels.list('me').labels || [];
  const existing = labels.find((label) => label.name === PORTAL.labelName);
  if (existing) return existing.id;
  const created = Gmail.Users.Labels.create({ name: PORTAL.labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, 'me');
  return created.id;
}

function addManagedLabel_(threadId) {
  const labelId = ensureManagedLabel_();
  Gmail.Users.Threads.modify({ addLabelIds: [labelId] }, 'me', threadId);
}

function threadView_(thread, email, record) {
  const messages = (thread.messages || []).map((message) => messageView_(message, email));
  const visible = messages.filter((message) => !message.blocked && message.body);
  const lastVisible = visible.length ? visible[visible.length - 1] : null;
  return {
    threadId: record.threadId,
    recipient: record.recipient,
    createdAt: String(record.createdAt || ''),
    lastSeenAt: String(record.lastSeenAt || ''),
    subject: lastVisible ? lastVisible.subject : 'Private conversation',
    preview: lastVisible ? lastVisible.body.slice(0, 220) : 'This conversation is hidden by the privacy filter.',
    messages,
  };
}

function messageView_(message, accountEmail) {
  const subject = header_(message, 'Subject');
  const from = header_(message, 'From');
  const date = header_(message, 'Date');
  const hasAttachment = hasAttachment_(message.payload);
  const body = plainBody_(message.payload);
  if (hasAttachment || hasFinancialPattern_(subject + '\n' + body)) {
    return { id: message.id, blocked: true, date: date || '', from: '', subject: '', body: '' };
  }
  return {
    id: message.id,
    blocked: false,
    date: date || '',
    from: addressFrom_(from) || (from || ''),
    mine: addressFrom_(from).toLowerCase() === accountEmail.toLowerCase(),
    subject: safeDisplayText_(subject, 180),
    body: safeDisplayText_(body, PORTAL.maxBodyChars),
  };
}

function latestInbound_(thread, accountEmail) {
  const messages = (thread.messages || []).slice().reverse();
  return messages.find((message) => {
    const from = addressFrom_(header_(message, 'From'));
    return from && from.toLowerCase() !== accountEmail.toLowerCase();
  }) || null;
}

function rawMessage_(recipients, subject, body, extraHeaders, attachments) {
  const files = attachments || [];
  const headers = [
    'To: ' + recipients.join(', '),
    'Subject: ' + mimeHeader_(subject),
    'MIME-Version: 1.0',
  ].concat(extraHeaders || []);
  let raw;
  if (!files.length) {
    raw = headers.concat([
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
    ]).join('\r\n') + '\r\n\r\n' + body.replace(/\r?\n/g, '\r\n');
  } else {
    const boundary = 'TeacherMailDesk_' + Utilities.getUuid().replace(/-/g, '');
    headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    const parts = [
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body.replace(/\r?\n/g, '\r\n'),
    ];
    files.forEach((file) => {
      parts.push(
        '--' + boundary,
        'Content-Type: ' + file.mimeType + '; name="' + mimeHeader_(file.name) + '"',
        'Content-Disposition: attachment; filename="' + mimeHeader_(file.name) + '"',
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64_(file.base64),
      );
    });
    parts.push('--' + boundary + '--', '');
    raw = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  }
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(raw).getBytes()).replace(/=+$/g, '');
}

function normalizeAttachments_(attachments) {
  if (!attachments) return [];
  if (!Array.isArray(attachments) || attachments.length > 5) throw new Error('Attach no more than 5 files per message.');
  let totalBytes = 0;
  return attachments.map((attachment) => {
    const name = cleanText_(attachment && attachment.name, 160).replace(/[\\/]/g, '_');
    const mimeType = cleanText_(attachment && attachment.mimeType, 120) || 'application/octet-stream';
    const base64 = String(attachment && attachment.base64 || '').replace(/\s/g, '');
    if (!name || !base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('One attachment is invalid.');
    const size = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    totalBytes += size;
    if (totalBytes > PORTAL.maxAttachmentBytes) throw new Error('Attachments are limited to 20 MB total per message.');
    return { name, mimeType, base64, size };
  });
}

function wrapBase64_(base64) {
  return String(base64 || '').replace(/(.{1,76})/g, '$1\r\n').replace(/\r\n$/, '');
}

function mimeHeader_(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value.replace(/[\r\n]/g, ' ');
  const encoded = Utilities.base64Encode(Utilities.newBlob(value).getBytes());
  return '=?UTF-8?B?' + encoded + '?=';
}

function plainBody_(payload) {
  if (!payload) return '';
  const parts = payload.parts || [];
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return decodeBase64Url_(payload.body.data);
  for (const part of parts) {
    const text = plainBody_(part);
    if (text) return text;
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) return stripHtml_(decodeBase64Url_(payload.body.data));
  return '';
}

function hasAttachment_(payload) {
  if (!payload) return false;
  if (payload.filename) return true;
  return (payload.parts || []).some((part) => hasAttachment_(part));
}

function decodeBase64Url_(value) {
  try { return Utilities.newBlob(Utilities.base64DecodeWebSafe(value)).getDataAsString('UTF-8'); } catch (error) { return ''; }
}

function stripHtml_(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function hasFinancialPattern_(value) {
  const text = String(value || '');
  const patterns = [
    /\b(bank|banking|wire|routing|sort code|swift|bic|iban|account number|account details|credit card|debit card|card number|cash app|venmo|zelle|paypal|crypto|wallet|bitcoin|invoice|refund|salary|payroll|tax|loan|mortgage|social security|ssn)\b/i,
    /\b(?:\d[ -]?){12,19}\b/,
    /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function assertSafeContent_(value) {
  if (hasFinancialPattern_(value)) throw new Error('This message was blocked by the privacy filter because it may contain financial or account data.');
}

function parseRecipients_(value) {
  const recipients = String(value || '').split(/[;,\n]+/).map((item) => item.trim()).filter(Boolean);
  if (!recipients.length || recipients.length > 10 || recipients.some((item) => !isEmail_(item))) throw new Error('Enter up to 10 valid recipient email addresses.');
  return recipients;
}

function isEmail_(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '')); }

function addressFrom_(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim().toLowerCase();
}

function header_(message, name) {
  const header = (message && message.payload && message.payload.headers || []).find((item) => String(item.name).toLowerCase() === name.toLowerCase());
  return header ? String(header.value || '') : '';
}

function validateAccountInputs_(accountName, password, accessCode) {
  if (!activeEmail_()) throw new Error('Sign in to the teacher Google account first.');
  if (!String(accountName || '').trim()) throw new Error('Enter the account name.');
  if (String(password || '').length < 6) throw new Error('Use a password with at least 6 characters.');
  if (String(accessCode || '').length < 4) throw new Error('Enter the access code supplied by the administrator.');
}

function saveSession_(token) { userProperties_().setProperty(PORTAL.sessionProperty, String(token)); }
function userProperties_() { return PropertiesService.getUserProperties(); }

function activeEmail_() {
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!isEmail_(email)) throw new Error('The teacher Google account could not be identified. Open the web app while signed in to one Google account.');
  return email;
}

function cleanText_(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

function safeDisplayText_(value, maxLength) {
  return cleanText_(value, maxLength);
}

function publicError_(error) {
  return String(error && error.message ? error.message : 'Request failed.').replace(/https?:\/\/\S+/g, '[link hidden]').slice(0, 260);
}
