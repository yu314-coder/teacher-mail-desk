/**
 * Teacher Mail Desk portal.
 *
 * Deploy this project as a web app executing as the owner. The teacher never
 * authorizes Gmail; Gmail sends and reads run through the owner's account.
 * GitHub Pages only displays the interface and never receives Gmail tokens.
 */

const PORTAL = {
  pagesUrl: 'https://yu314-coder.github.io/teacher-mail-desk/',
  labelName: 'TeacherPortal/Managed',
  maxThreads: 30,
  maxBodyChars: 60000,
  maxAttachmentBytes: 20 * 1024 * 1024,
  auditForwardTo: 'imadmitted@gmail.com',
  sessionProperty: 'PORTAL_SESSION_TOKEN',
};

function doGet(e) {
  if (e && e.parameter && e.parameter.bridge === '1') {
    return HtmlService.createHtmlOutputFromFile('Bridge')
      .setTitle('Teacher Mail Desk bridge')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return HtmlService.createHtmlOutput('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><p>Opening Teacher Mail Desk…</p><script>window.top.location.replace(' + JSON.stringify(PORTAL.pagesUrl) + ');</script></body></html>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Accepts the GitHub Pages login/register form without exposing credentials
 * to GitHub or a browser cross-origin API. The form is HTTPS POSTed directly
 * to this web app, then the teacher is redirected into the Apps Script UI.
 */
function doPost(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  if (parameters.bridge === '1') {
    try {
      return bridgePost_(parameters);
    } catch (error) {
      return bridgeResponse_(
        cleanText_(parameters.requestId, 120),
        cleanText_(parameters.nonce, 180),
        false,
        null,
        publicError_(error)
      );
    }
  }
  try {
    backendEmail_();

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

function bridgePost_(parameters) {
  const method = String(parameters.method || '').trim();
  const requestId = cleanText_(parameters.requestId, 120);
  const nonce = cleanText_(parameters.nonce, 180);
  const args = JSON.parse(String(parameters.args || '[]'));
  if (!requestId || !nonce || !Array.isArray(args)) throw new Error('Invalid bridge request.');
  let result;
  switch (method) {
    case 'getAppState': result = getAppState(); break;
    case 'signUp': result = signUp(args[0], args[1], args[2]); break;
    case 'signIn': result = signIn(args[0], args[1], args[2]); break;
    case 'signOut': result = signOut(args[0]); break;
    case 'setupMailbox': result = setupMailbox(args[0]); break;
    case 'listManagedThreads': result = listManagedThreads(args[0]); break;
    case 'syncManagedInbox': result = syncManagedInbox(args[0]); break;
    case 'getManagedThread': result = getManagedThread(args[0], args[1]); break;
    case 'getManagedThreadRemote': result = getManagedThreadRemote(args[0], args[1]); break;
    case 'sendMessage': result = sendMessage(args[0], args[1], args[2], args[3], args[4]); break;
    case 'replyToThread': result = replyToThread(args[0], args[1], args[2], args[3]); break;
    case 'forwardMessage': result = forwardMessage(args[0], args[1], args[2], args[3], args[4], args[5]); break;
    default: throw new Error('Unknown bridge operation.');
  }
  return bridgeResponse_(requestId, nonce, true, result, '');
}

function bridgeResponse_(requestId, nonce, ok, result, error) {
  const message = JSON.stringify({
    type: 'teacher-mail-desk:response',
    requestId,
    nonce,
    ok: Boolean(ok),
    result: ok ? result : null,
    error: ok ? '' : String(error || 'Request failed.'),
  }).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput('<!doctype html><html><body><script>window.top.postMessage(' + message + ', "*");</script></body></html>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
  const email = backendEmail_();
  try {
    const registration = loggerCall_('sessionState', { email });
    return { ok: true, registered: Boolean(registration.registered), authenticated: false };
  } catch (error) {
    return { ok: false, code: 'PORTAL_SETUP_REQUIRED', message: publicError_(error) };
  }
}

function signUp(accountName, password, accessCode) {
  const email = backendEmail_();
  validateAccountInputs_(accountName, password, accessCode);
  const result = loggerCall_('register', { email, accountName, password, accessCode });
  return { ok: true, sessionToken: result.sessionToken, expiresAt: result.expiresAt };
}

function signIn(accountName, password, accessCode) {
  const email = backendEmail_();
  if (!String(accountName || '').trim()) throw new Error('Enter the account name.');
  if (!password || String(password).length < 6) throw new Error('Use a password with at least 6 characters.');
  if (!accessCode || String(accessCode).length < 4) throw new Error('Enter the administrator access code.');
  const result = loggerCall_('login', { email, accountName: String(accountName), password: String(password), accessCode: String(accessCode) });
  return { ok: true, sessionToken: result.sessionToken, expiresAt: result.expiresAt };
}

function signOut(sessionToken) {
  if (sessionToken) {
    try { loggerCall_('logout', { email: backendEmail_(), sessionToken: String(sessionToken) }); } catch (ignored) {}
  }
  return { ok: true };
}

function listManagedThreads(sessionToken) {
  const email = backendEmail_();
  const snapshot = loggerCall_('mailboxSnapshot', { email, sessionToken });
  let allowedSenders = new Set(snapshot.allowedSenders || []);
  if (!allowedSenders.size) {
    const sentRecipients = extractEmails_((snapshot.messages || []).map((audit) => audit && audit.to).join(' '));
    if (sentRecipients.length) {
      try {
        const seeded = loggerCall_('ensureAllowedSenders', { email, sessionToken, senders: sentRecipients });
        if (seeded && Array.isArray(seeded.allowedSenders)) allowedSenders = new Set(seeded.allowedSenders);
      } catch (ignored) {}
    }
  }
  const auditByThreadId = {};
  (snapshot.messages || []).forEach((audit) => {
    if (!audit) return;
    if (audit.threadId) {
      const threadAudits = auditByThreadId[String(audit.threadId)] || (auditByThreadId[String(audit.threadId)] = []);
      threadAudits.push(audit);
    }
  });
  const allowed = managedThreadRecords_(email, allowedSenders, snapshot.threads || [], false).slice(0, PORTAL.maxThreads);
  // Keep the first mailbox request light. Gmail only loads the full message
  // payload after the teacher opens a conversation, just like Gmail's list
  // view does. This avoids one slow full-thread API request per row.
  const result = allowed.map((record) => threadSummary_(record, email, auditByThreadId[String(record.threadId)] || []));
  result.sort((a, b) => dateValue_(b.lastMessageAt) - dateValue_(a.lastMessageAt));
  return { ok: true, threads: result, allowedSenders: Array.from(allowedSenders).sort() };
}

function syncManagedInbox(sessionToken) {
  const email = backendEmail_();
  const snapshot = loggerCall_('mailboxSnapshot', { email, sessionToken });
  const allowedSenders = new Set(snapshot.allowedSenders || []);
  const auditByThreadId = {};
  (snapshot.messages || []).forEach((audit) => {
    if (!audit || !audit.threadId) return;
    const list = auditByThreadId[String(audit.threadId)] || (auditByThreadId[String(audit.threadId)] = []);
    list.push(audit);
  });
  const records = managedThreadRecords_(email, allowedSenders, snapshot.threads || [], true).slice(0, PORTAL.maxThreads);
  const threads = records.map((record) => threadSummary_(record, email, auditByThreadId[String(record.threadId)] || []));
  threads.sort((a, b) => dateValue_(b.lastMessageAt) - dateValue_(a.lastMessageAt));
  return { ok: true, threads, allowedSenders: Array.from(allowedSenders).sort() };
}

function getManagedThread(sessionToken, threadId) {
  const email = backendEmail_();
  const id = cleanText_(threadId, 160);
  if (!id) throw new Error('Choose a conversation first.');
  const snapshot = loggerCall_('mailboxSnapshot', { email, sessionToken });
  const allowedSenders = new Set(snapshot.allowedSenders || []);
  const records = (snapshot.threads || []).filter((record) => record && String(record.threadId) === id);
  let record = records.length ? records[0] : null;
  const audits = (snapshot.messages || []).filter((audit) => audit && String(audit.threadId || '') === id);
  // Portal-sent messages are already privacy-filtered and stored in the
  // private Sheet logger. Use that copy immediately instead of waiting on a
  // second Gmail payload request just to open a sent conversation.
  if (record && audits.length) return { ok: true, thread: threadViewFromAudits_(email, record, audits) };
  // A discovered Inbox thread has no portal audit row by design. Fetch its
  // complete Gmail payload once now so opening it shows the actual sender,
  // headers, body, and safe attachment metadata immediately. The previous
  // path returned a placeholder and then made a second slow GmailApp call.
  if (record && record.inbound) {
    const thread = Gmail.Users.Threads.get('me', id, { format: 'full' });
    return { ok: true, thread: threadView_(thread, email, record, allowedSenders, groupAuditsByMessage_(snapshot.messages || [])) };
  }
  if (record) {
    const summary = threadSummary_(record, email, []);
    summary.needsRemoteCheck = true;
    summary.messageCount = 0;
    return { ok: true, thread: summary };
  }
  const thread = Gmail.Users.Threads.get('me', id, { format: 'full' });

  // Older portal versions could label a managed thread before the Sheet row
  // was written. Accept that thread only when Gmail confirms the private
  // portal label, never from a client-supplied ID alone.
  if (!record) {
    const managedLabel = (Gmail.Users.Labels.list('me').labels || []).find((label) => label.name === PORTAL.labelName);
    const hasManagedLabel = Boolean(managedLabel && (thread.messages || []).some((message) => (message.labelIds || []).indexOf(managedLabel.id) >= 0));
    if (!hasManagedLabel) throw new Error('That conversation was not started through this portal.');
    record = { threadId: id, recipient: '', createdAt: '', lastSeenAt: '' };
  }
  return { ok: true, thread: threadView_(thread, email, record, allowedSenders, groupAuditsByMessage_(snapshot.messages || [])) };
}

function getManagedThreadRemote(sessionToken, threadId) {
  const email = backendEmail_();
  const id = cleanText_(threadId, 160);
  if (!id) throw new Error('Choose a conversation first.');
  const snapshot = loggerCall_('mailboxSnapshot', { email, sessionToken });
  const allowedSenders = new Set(snapshot.allowedSenders || []);
  let record = (snapshot.threads || []).find((item) => item && String(item.threadId) === id) || null;
  const gmailThread = GmailApp.getThreadById(id);
  if (!gmailThread) throw new Error('The Gmail conversation could not be found.');
  if (!record) {
    const labels = gmailThread.getLabels().map((label) => label.getName());
    if (labels.indexOf(PORTAL.labelName) < 0) throw new Error('That conversation was not started through this portal.');
    record = { threadId: id, recipient: '', createdAt: '', lastSeenAt: '' };
  }
  return { ok: true, thread: gmailAppThreadView_(gmailThread, email, record, allowedSenders, groupAuditsByMessage_(snapshot.messages || [])) };
}

function groupAuditsByMessage_(audits) {
  const byMessageId = {};
  const byThreadId = {};
  (audits || []).forEach((audit) => {
    if (!audit) return;
    if (audit.messageId) byMessageId[String(audit.messageId)] = audit;
    if (audit.threadId) {
      const list = byThreadId[String(audit.threadId)] || (byThreadId[String(audit.threadId)] = []);
      list.push(audit);
    }
  });
  return { byMessageId, byThreadId };
}

function threadSummary_(record, email, audits) {
  const threadAudits = (audits || []).slice().sort((a, b) => dateValue_(b.timestamp) - dateValue_(a.timestamp));
  const latest = threadAudits[0] || null;
  const hasSent = threadAudits.some((audit) => String(audit.direction || '').toLowerCase() === 'sent');
  return {
    threadId: record.threadId,
    recipient: String(record.recipient || '').trim(),
    createdAt: String(record.createdAt || ''),
    lastSeenAt: String(record.lastSeenAt || ''),
    lastMessageAt: latest ? String(latest.timestamp || record.lastSeenAt || record.createdAt || '') : String(record.lastSeenAt || record.createdAt || ''),
    sender: latest && latest.from ? addressFrom_(latest.from) : String(record.sender || record.recipient || (record.inbound ? 'Allowed sender' : '')),
    hasInbound: Boolean(record.inbound),
    hasSent,
    subject: latest ? safeDisplayText_(latest.subject || 'Private conversation', 180) : safeDisplayText_(record.subject || (record.inbound ? 'Incoming message' : 'Managed conversation'), 180),
    preview: latest && latest.body ? safeDisplayText_(latest.body, 220) : safeDisplayText_(record.preview || 'Open to load the complete conversation.', 220),
    messageCount: threadAudits.length,
    loaded: false,
    messages: [],
  };
}

function threadViewFromAudits_(email, record, audits) {
  const messages = (audits || []).slice().sort((a, b) => dateValue_(a.timestamp) - dateValue_(b.timestamp)).map((audit) => {
    const timestamp = String(audit.timestamp || '');
    const synthetic = {
      id: String(audit.messageId || ''),
      internalDate: timestamp ? String(new Date(timestamp).getTime()) : '',
      payload: {
        headers: [
          { name: 'From', value: String(audit.from || email) },
          { name: 'To', value: String(audit.to || '') },
          { name: 'Subject', value: String(audit.subject || '') },
          { name: 'Date', value: timestamp ? new Date(timestamp).toUTCString() : '' },
        ],
      },
    };
    return synthetic;
  });
  const grouped = groupAuditsByMessage_(audits);
  const view = threadView_({ messages }, email, record, new Set(), grouped);
  view.needsRemoteCheck = true;
  return view;
}

function gmailAppThreadView_(gmailThread, email, record, allowedSenders, auditIndex) {
  const auditByMessageId = auditIndex && auditIndex.byMessageId ? auditIndex.byMessageId : {};
  const messageViews = gmailThread.getMessages().map((message) => gmailAppMessageView_(message, email, auditByMessageId[String(message.getId() || '')] || null));
  return threadViewFromMessageViews_(messageViews, email, record, allowedSenders);
}

function gmailAppMessageView_(message, accountEmail, audit) {
  const subject = String(message.getSubject() || String(audit && audit.subject || ''));
  const from = String(message.getFrom() || String(audit && audit.from || ''));
  const body = String(message.getPlainBody() || String(audit && audit.body || ''));
  const attachments = message.getAttachments().map((file) => ({
    name: safeDisplayText_(file.getName(), 160),
    mimeType: safeDisplayText_(file.getContentType(), 120),
    size: Number(file.getSize() || 0),
  })).slice(0, 20);
  const blocked = hasFinancialPattern_(subject + '\n' + body + '\n' + attachments.map((file) => file.name + ' ' + file.mimeType).join('\n'));
  return {
    id: String(message.getId() || ''),
    blocked,
    attachment: attachments.length > 0 || Boolean(audit && audit.attachmentMetadata),
    date: message.getDate() instanceof Date ? message.getDate().toISOString() : String(audit && audit.timestamp || ''),
    from: blocked ? '' : addressFrom_(from) || from,
    fromName: blocked ? '' : safeDisplayText_(displayNameFrom_(from), 180),
    to: blocked ? '' : safeDisplayText_(message.getTo() || String(audit && audit.to || ''), 1000),
    cc: blocked ? '' : safeDisplayText_(message.getCc() || '', 1000),
    replyTo: blocked ? '' : safeDisplayText_(message.getReplyTo() || '', 500),
    mine: addressFrom_(from).toLowerCase() === accountEmail.toLowerCase(),
    subject: blocked ? '' : safeDisplayText_(subject, 180),
    body: blocked ? '' : safeDisplayText_(body, PORTAL.maxBodyChars),
    attachments: blocked ? [] : attachments,
  };
}

function threadViewFromMessageViews_(messageViews, email, record, allowedSenders) {
  const messages = (messageViews || []).filter((message) => {
    const from = addressFrom_(message.from);
    return !from || from === email || allowedSenders.has(from);
  });
  const visible = messages.filter((message) => !message.blocked && message.body);
  const lastVisible = visible.length ? visible[visible.length - 1] : null;
  const inbound = messages.filter((message) => !message.mine);
  const sent = messages.filter((message) => message.mine);
  const lastMessage = messages.length ? messages[messages.length - 1] : null;
  return {
    threadId: record.threadId,
    recipient: String(record.recipient || '').trim(),
    createdAt: String(record.createdAt || ''),
    lastSeenAt: String(record.lastSeenAt || ''),
    lastMessageAt: lastMessage ? lastMessage.date : String(record.lastSeenAt || record.createdAt || ''),
    sender: inbound.length ? inbound[inbound.length - 1].from : '',
    hasInbound: inbound.length > 0,
    hasSent: sent.length > 0,
    subject: lastVisible ? lastVisible.subject : 'Private conversation',
    preview: lastVisible ? lastVisible.body.slice(0, 220) : 'This conversation is hidden by the privacy filter.',
    messageCount: messages.length,
    needsRemoteCheck: false,
    messages,
  };
}

function sendMessage(sessionToken, to, subject, body, attachments) {
  const email = requireSession_(sessionToken);
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
  try { loggerCall_('ensureAllowedSenders', { email, sessionToken, senders: recipients }); } catch (ignored) {}
  recordAudit_(email, 'send', sent.threadId, sent.id || '', 'success', '');
  recordMessageAudit_(email, 'sent', 'send', sent.threadId, sent.id || '', email, recipients.join(', '), cleanSubject, cleanBody, safeAttachments);
  forwardAuditCopy_(email, recipients, cleanSubject, cleanBody, sent, safeAttachments);
  return { ok: true, sent: true };
}

function replyToThread(sessionToken, threadId, body, attachments) {
  const email = requireSession_(sessionToken);
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
  if (inbound && !allowedSendersFor_(email).has(addressFrom_(header_(inbound, 'From')))) {
    recordAudit_(email, 'reply', id, '', 'blocked', 'Inbound sender is not on AllowedSenders.');
    throw new Error('This sender is not on the AllowedSenders list.');
  }
  const recipient = inbound
    ? addressFrom_(header_(inbound, 'From'))
    : String(record.recipient || '').split(',')[0].trim() || recipientFromThread_(thread, email);
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

function forwardMessage(sessionToken, threadId, messageId, to, note, attachments) {
  const email = requireSession_(sessionToken);
  const allowed = allowedThreadMap_(email);
  const id = cleanText_(threadId, 160);
  const record = allowed[id];
  if (!record) throw new Error('That conversation was not started through this portal.');
  const recipients = parseRecipients_(to);
  const thread = Gmail.Users.Threads.get('me', id, { format: 'full' });
  const source = (thread.messages || []).find((message) => String(message.id || '') === cleanText_(messageId, 160));
  if (!source) throw new Error('The selected message could not be found.');
  const sourceFrom = addressFrom_(header_(source, 'From'));
  if (sourceFrom && sourceFrom !== email && !allowedSendersFor_(email).has(sourceFrom)) {
    recordAudit_(email, 'forward', id, source.id || '', 'blocked', 'Inbound sender is not on AllowedSenders.');
    throw new Error('This sender is not on the AllowedSenders list.');
  }
  const sourceSubject = header_(source, 'Subject') || 'Teacher Mail Desk conversation';
  const sourceBody = plainBody_(source.payload);
  if (!sourceBody || hasAttachment_(source.payload) || hasFinancialPattern_(sourceSubject + '\n' + sourceBody)) {
    throw new Error('This message is hidden by the privacy filter and cannot be forwarded.');
  }
  const cleanNote = cleanText_(note, PORTAL.maxBodyChars);
  const forwardedBody = [
    cleanNote,
    cleanNote ? '' : null,
    '---------- Forwarded message ----------',
    'From: ' + (header_(source, 'From') || 'Sender hidden'),
    'Date: ' + (header_(source, 'Date') || ''),
    'Subject: ' + sourceSubject,
    '',
    sourceBody,
  ].filter((line) => line !== null).join('\n');
  assertSafeContent_(sourceSubject + '\n' + forwardedBody);
  const safeAttachments = normalizeAttachments_(attachments);
  const forwardSubject = /^fwd:/i.test(sourceSubject) ? sourceSubject : 'Fwd: ' + sourceSubject;
  const sent = Gmail.Users.Messages.send({ raw: rawMessage_(recipients, forwardSubject, forwardedBody, [], safeAttachments) }, 'me');
  if (!sent || !sent.threadId) throw new Error('Gmail did not return a thread ID.');
  ensureManagedLabel_();
  addManagedLabel_(sent.threadId);
  loggerCall_('recordThread', { email, threadId: sent.threadId, recipient: recipients.join(', ') });
  recordAudit_(email, 'forward', sent.threadId, sent.id || '', 'success', '');
  recordMessageAudit_(email, 'sent', 'forward', sent.threadId, sent.id || '', email, recipients.join(', '), forwardSubject, forwardedBody, safeAttachments);
  forwardAuditCopy_(email, recipients, forwardSubject, forwardedBody, sent, safeAttachments);
  return { ok: true, sent: true };
}

function setupMailbox(sessionToken) {
  requireSession_(sessionToken);
  ensureManagedLabel_();
  return { ok: true, label: PORTAL.labelName };
}

function requireSession_(sessionToken) {
  const email = backendEmail_();
  const token = String(sessionToken || '').trim();
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
  const retryable = ['mailboxSnapshot', 'authorize', 'listThreads', 'listAllowedSenders'].indexOf(operation) >= 0;
  let lastError = null;
  for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error;
      if (attempt + 1 < (retryable ? 2 : 1)) Utilities.sleep(150);
    }
  }
  throw lastError || new Error('The private Sheet logger did not respond.');
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
    ? attachments.map((file) => '- ' + file.name + ' (' + file.size + ' bytes)').join('\n')
    : '';
  const auditSubject = /^\[Teacher Mail Desk\]/i.test(subject) ? subject : '[Teacher Mail Desk] ' + subject;
  const auditBody = [
    '---------- Forwarded message ----------',
    'From: Teacher Mail Desk <' + email + '>',
    'To: ' + recipients.join(', '),
    'Subject: ' + subject,
    '',
    body,
    attachmentSummary ? ['', 'Attachment files retained in the managed Gmail account:', attachmentSummary].join('\n') : '',
  ].join('\n');
  try {
    const forwarded = Gmail.Users.Messages.send({ raw: rawMessage_([PORTAL.auditForwardTo], auditSubject, auditBody) }, 'me');
    recordAudit_(email, 'audit_forward', sent && sent.threadId ? sent.threadId : '', forwarded && forwarded.id ? forwarded.id : '', 'success', PORTAL.auditForwardTo);
  } catch (error) {
    recordAudit_(email, 'audit_forward', sent && sent.threadId ? sent.threadId : '', '', 'error', 'Audit copy failed');
  }
}

function allowedThreadMap_(email) {
  const allowedSenders = new Set(loggerCall_('listAllowedSenders', { email }));
  const records = managedThreadRecords_(email, allowedSenders);
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

function threadView_(thread, email, record, allowedSenders, auditByMessageId) {
  const messages = (thread.messages || [])
    .filter((message) => {
      const from = addressFrom_(header_(message, 'From'));
      return !from || from === email || allowedSenders.has(from);
    })
    .map((message, index) => {
      const auditIndex = auditByMessageId || {};
      const byMessageId = auditIndex.byMessageId || auditIndex;
      const byThreadId = auditIndex.byThreadId || {};
      const threadAudits = byThreadId[String(record.threadId)] || [];
      const audit = byMessageId[String(message.id || '')] || threadAudits[index] || threadAudits[0];
      return messageView_(message, email, audit);
    });
  const visible = messages.filter((message) => !message.blocked && message.body);
  const lastVisible = visible.length ? visible[visible.length - 1] : null;
  const inbound = messages.filter((message) => !message.mine);
  const sent = messages.filter((message) => message.mine);
  const lastMessage = messages.length ? messages[messages.length - 1] : null;
  const recipient = String(record.recipient || '').trim() || (inbound.length ? inbound[inbound.length - 1].from : recipientFromThread_(thread, email));
  return {
    threadId: record.threadId,
    recipient,
    createdAt: String(record.createdAt || ''),
    lastSeenAt: String(record.lastSeenAt || ''),
    lastMessageAt: lastMessage ? lastMessage.date : String(record.lastSeenAt || record.createdAt || ''),
    sender: inbound.length ? inbound[inbound.length - 1].from : '',
    hasInbound: inbound.length > 0,
    hasSent: sent.length > 0,
    subject: lastVisible ? lastVisible.subject : 'Private conversation',
    preview: lastVisible ? lastVisible.body.slice(0, 220) : 'This conversation is hidden by the privacy filter.',
    messages,
  };
}

function messageView_(message, accountEmail, audit) {
  const subject = header_(message, 'Subject') || String(audit && audit.subject || '');
  const from = header_(message, 'From') || String(audit && audit.from || '');
  const date = header_(message, 'Date') || (message.internalDate ? new Date(Number(message.internalDate)).toISOString() : String(audit && audit.timestamp || ''));
  const hasAttachment = hasAttachment_(message.payload);
  const body = plainBody_(message.payload) || String(audit && audit.body || '');
  const attachments = attachmentSummaries_(message.payload, audit);
  const attachmentNames = attachments.map((file) => file.name + ' ' + file.mimeType).join('\n');
  if (hasFinancialPattern_(subject + '\n' + body + '\n' + attachmentNames)) {
    return {
      id: message.id,
      blocked: true,
      attachment: hasAttachment || Boolean(audit && audit.attachmentMetadata),
      date: date || '',
      from: '',
      fromName: '',
      to: '',
      cc: '',
      replyTo: '',
      subject: '',
      body: '',
      attachments: [],
      mine: addressFrom_(from).toLowerCase() === accountEmail.toLowerCase(),
    };
  }
  return {
    id: message.id,
    blocked: false,
    attachment: hasAttachment || Boolean(audit && audit.attachmentMetadata),
    date: date || '',
    from: addressFrom_(from) || (from || ''),
    fromName: safeDisplayText_(displayNameFrom_(from), 180),
    to: safeDisplayText_(header_(message, 'To') || String(audit && audit.to || ''), 1000),
    cc: safeDisplayText_(header_(message, 'Cc'), 1000),
    replyTo: safeDisplayText_(header_(message, 'Reply-To'), 500),
    mine: addressFrom_(from).toLowerCase() === accountEmail.toLowerCase(),
    subject: safeDisplayText_(subject, 180),
    body: safeDisplayText_(body, PORTAL.maxBodyChars),
    attachments,
  };
}

function displayNameFrom_(value) {
  const match = String(value || '').match(/^\s*(.*?)\s*<[^>]+>\s*$/);
  return match ? match[1].replace(/^"|"$/g, '').trim() : '';
}

function attachmentSummaries_(payload, audit) {
  const result = [];
  function collect(part) {
    if (!part) return;
    if (part.filename) result.push({ name: safeDisplayText_(part.filename, 160), mimeType: safeDisplayText_(part.mimeType, 120), size: Number(part.body && part.body.size || 0) });
    (part.parts || []).forEach(collect);
  }
  collect(payload);
  if (!result.length && audit && audit.attachmentMetadata) {
    String(audit.attachmentMetadata).split('\n').forEach((line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.name) result.push({ name: safeDisplayText_(parsed.name, 160), mimeType: safeDisplayText_(parsed.mimeType, 120), size: Number(parsed.size || 0) });
      } catch (ignored) {}
    });
  }
  return result.slice(0, 20);
}

function latestInbound_(thread, accountEmail) {
  const messages = (thread.messages || []).slice().reverse();
  return messages.find((message) => {
    const from = addressFrom_(header_(message, 'From'));
    return from && from.toLowerCase() !== accountEmail.toLowerCase();
  }) || null;
}

function allowedSendersFor_(email) {
  return new Set(loggerCall_('listAllowedSenders', { email }));
}

function managedThreadRecords_(email, allowedSenders, preloadedRecords, discoverInbound) {
  const records = (preloadedRecords || loggerCall_('listThreads', { email })).slice(-100).reverse();
  const byId = {};
  const discovered = [];
  records.forEach((record) => {
    if (record && record.threadId) byId[record.threadId] = record;
  });

  // Recover older conversations already marked by this portal, even if an
  // older portal version did not yet write the thread row to the Sheet.
  if (discoverInbound && (!preloadedRecords || !preloadedRecords.length) && Object.keys(byId).length < PORTAL.maxThreads) {
    try {
      const managedLabel = (Gmail.Users.Labels.list('me').labels || []).find((label) => label.name === PORTAL.labelName);
      if (managedLabel) {
        const response = Gmail.Users.Threads.list('me', { labelIds: [managedLabel.id], maxResults: PORTAL.maxThreads });
        (response.threads || []).forEach((thread) => {
          const threadId = String(thread.id || '').trim();
          if (threadId && !byId[threadId]) byId[threadId] = { threadId, recipient: '', createdAt: '', lastSeenAt: '' };
        });
      }
    } catch (ignored) {}
  }

  // A Sheet-approved sender may start a brand-new Gmail thread instead of
  // replying to a portal-created message. Discover those threads and bring
  // them inside the same managed boundary so the teacher can reply here.
  if (discoverInbound && allowedSenders && allowedSenders.size && Object.keys(byId).length < PORTAL.maxThreads) {
    try {
      const senderQuery = '{' + Array.from(allowedSenders).slice(0, 20).map((sender) => 'from:' + sender).join(' ') + '}';
      const response = Gmail.Users.Threads.list('me', { q: senderQuery, maxResults: PORTAL.maxThreads });
      (response.threads || []).forEach((thread) => {
        const threadId = String(thread.id || '').trim();
        if (!threadId) return;
        const preview = safeDisplayText_(thread.snippet || '', 220);
        if (byId[threadId]) {
          byId[threadId].inbound = true;
          if (preview) byId[threadId].preview = preview;
          if (!byId[threadId].sender) byId[threadId].sender = 'Allowed sender';
          return;
        }
        const record = { threadId, recipient: '', createdAt: '', lastSeenAt: '', inbound: true, preview, sender: 'Allowed sender' };
        byId[threadId] = record;
        discovered.push({ threadId, recipient: '' });
      });
    } catch (ignored) {}
  }
  if (discovered.length) {
    try { loggerCall_('recordThreads', { email, threads: discovered }); } catch (ignored) {}
  }
  return Object.keys(byId).map((threadId) => byId[threadId]);
}

function extractEmails_(value) {
  return Array.from(new Set(String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])).map((email) => email.toLowerCase()).filter(isEmail_);
}

function dateValue_(value) {
  const timestamp = new Date(value || '').getTime();
  return isNaN(timestamp) ? 0 : timestamp;
}

function recipientFromThread_(thread, email) {
  const messages = (thread && thread.messages || []).slice().reverse();
  for (const message of messages) {
    if (addressFrom_(header_(message, 'From')) !== email) continue;
    const match = String(header_(message, 'To') || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const recipient = match ? match[0].toLowerCase() : '';
    if (recipient && recipient !== email) return recipient;
  }
  return '';
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
  if (!String(accountName || '').trim()) throw new Error('Enter the account name.');
  if (String(password || '').length < 6) throw new Error('Use a password with at least 6 characters.');
  if (String(accessCode || '').length < 4) throw new Error('Enter the access code supplied by the administrator.');
}

function backendEmail_() {
  const email = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!isEmail_(email)) throw new Error('The private Gmail backend account could not be identified.');
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
