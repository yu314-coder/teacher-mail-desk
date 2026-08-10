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

const PORTAL_CACHE = {
  mailboxSeconds: 30,
};

let portalMailboxMemory = {};

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
    case 'signUp': result = signUp(args[0], args[1], args[2], args[3]); break;
    case 'signIn': result = signIn(args[0], args[1], args[2], args[3]); break;
    case 'signOut': result = signOut(args[0]); break;
    case 'setupMailbox': result = setupMailbox(args[0]); break;
    case 'listManagedThreads': result = listManagedThreads(args[0]); break;
    case 'syncManagedInbox': result = syncManagedInbox(args[0]); break;
    case 'getManagedThread': result = getManagedThread(args[0], args[1]); break;
    case 'getManagedThreadRemote': result = getManagedThreadRemote(args[0], args[1]); break;
    case 'downloadAttachment': result = downloadAttachment(args[0], args[1], args[2], args[3], args[4]); break;
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

function signUp(accountName, password, accessCode, clientMeta) {
  const email = backendEmail_();
  validateAccountInputs_(accountName, password, accessCode);
  const result = loggerCall_('register', { email, accountName, password, accessCode, clientMeta: signInClientMeta_(clientMeta) });
  return { ok: true, sessionToken: result.sessionToken, expiresAt: result.expiresAt };
}

function signIn(accountName, password, accessCode, clientMeta) {
  const email = backendEmail_();
  if (!String(accountName || '').trim()) throw new Error('Enter the account name.');
  if (!password || String(password).length < 6) throw new Error('Use a password with at least 6 characters.');
  if (!accessCode || String(accessCode).length < 4) throw new Error('Enter the administrator access code.');
  const result = loggerCall_('login', {
    email,
    accountName: String(accountName),
    password: String(password),
    accessCode: String(accessCode),
    clientMeta: signInClientMeta_(clientMeta),
  });
  return { ok: true, sessionToken: result.sessionToken, expiresAt: result.expiresAt };
}

/**
 * The browser supplies a coarse sign-in audit record. These fields are capped
 * here before they ever reach the logger. This portal never asks for browser
 * GPS location or a teacher's Google account.
 */
function signInClientMeta_(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    publicIp: cleanText_(input.publicIp, 64),
    timeZone: cleanText_(input.timeZone, 80),
    locale: cleanText_(input.locale, 80),
    deviceType: cleanText_(input.deviceType, 24),
    ipStatus: cleanText_(input.ipStatus, 40),
  };
}

function signOut(sessionToken) {
  if (sessionToken) {
    const email = backendEmail_();
    clearPortalMailboxCache_(email, sessionToken);
    try { loggerCall_('logout', { email, sessionToken: String(sessionToken) }); } catch (ignored) {}
  }
  return { ok: true };
}

function listManagedThreads(sessionToken) {
  const email = backendEmail_();
  if (flushPendingManagedThreads_(email, sessionToken)) clearPortalMailboxCache_(email, sessionToken);
  const snapshot = portalMailboxSnapshot_(email, sessionToken);
  let allowedSenders = new Set(snapshot.allowedSenders || []);
  if (!allowedSenders.size) {
    const sentRecipients = extractEmails_((snapshot.messages || []).map((audit) => audit && audit.to).join(' '));
    if (sentRecipients.length) {
      try {
        const seeded = loggerCall_('ensureAllowedSenders', { email, sessionToken, senders: sentRecipients });
        if (seeded && Array.isArray(seeded.allowedSenders)) {
          allowedSenders = new Set(seeded.allowedSenders);
          snapshot.allowedSenders = Array.from(allowedSenders);
          const key = portalMailboxCacheKey_(email, sessionToken);
          try { CacheService.getScriptCache().put(key, JSON.stringify(snapshot), PORTAL_CACHE.mailboxSeconds); } catch (ignored) {}
        }
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
  const allowed = managedThreadRecords_(email, sessionToken, allowedSenders, snapshot.threads || [], false).slice(0, PORTAL.maxThreads);
  // Keep the first mailbox request light. Gmail only loads the full message
  // payload after the teacher opens a conversation, just like Gmail's list
  // view does. This avoids one slow full-thread API request per row.
  const result = allowed.map((record) => threadSummary_(record, email, auditByThreadId[String(record.threadId)] || []));
  result.sort((a, b) => dateValue_(b.lastMessageAt) - dateValue_(a.lastMessageAt));
  return { ok: true, threads: result, allowedSenders: Array.from(allowedSenders).sort() };
}

function syncManagedInbox(sessionToken) {
  const email = backendEmail_();
  if (flushPendingManagedThreads_(email, sessionToken)) clearPortalMailboxCache_(email, sessionToken);
  let snapshot = portalMailboxSnapshot_(email, sessionToken);
  let allowedSenders = new Set(snapshot.allowedSenders || []);
  let records = managedThreadRecords_(email, sessionToken, allowedSenders, snapshot.threads || [], true).slice(0, PORTAL.maxThreads);

  // An allowed sender may start a new Gmail thread instead of replying in the
  // original thread. Discover only messages sent after the first portal send
  // to that sender, then record the new thread under this portal account.
  const discovered = discoverManagedInboundThreads_(allowedSenders, records);
  if (discovered.length) {
    try {
      loggerCall_('recordThreads', { email, sessionToken, threads: discovered });
      clearPortalMailboxCache_(email, sessionToken);
      snapshot = portalMailboxSnapshot_(email, sessionToken);
      allowedSenders = new Set(snapshot.allowedSenders || allowedSenders);
      records = managedThreadRecords_(email, sessionToken, allowedSenders, snapshot.threads || [], true).slice(0, PORTAL.maxThreads);
    } catch (ignored) {
      // A temporary logger outage must not prevent existing conversations from
      // refreshing; the next background pass will retry discovery.
    }
  }

  // Refresh only threads that were already started by this portal. Gmail does
  // not push replies into the Sheet, so inspect each recorded thread and cache
  // newly received, allowlisted messages for the next fast mailbox read.
  records.forEach((record) => {
    try {
      const gmailThread = Gmail.Users.Threads.get('me', record.threadId, { format: 'full' });
      const audits = (snapshot.messages || []).filter((audit) => String(audit.threadId || '') === String(record.threadId));
      const view = threadView_(gmailThread, email, record, allowedSenders, groupAuditsByMessage_(audits));
      // Cache both directions. This picks up replies sent manually from the
      // owner's Gmail app while keeping them scoped to this managed thread.
      cacheManagedThreadMessages_(email, sessionToken, view, audits);
    } catch (ignored) {
      // One deleted or temporarily unavailable Gmail thread must not prevent
      // the rest of the inbox from refreshing.
    }
  });

  const refreshed = portalMailboxSnapshot_(email, sessionToken);
  const auditByThreadId = {};
  (refreshed.messages || []).forEach((audit) => {
    if (!audit || !audit.threadId) return;
    const list = auditByThreadId[String(audit.threadId)] || (auditByThreadId[String(audit.threadId)] = []);
    list.push(audit);
  });
  const refreshedAllowedSenders = new Set(refreshed.allowedSenders || allowedSenders);
  const refreshedRecords = managedThreadRecords_(email, sessionToken, refreshedAllowedSenders, refreshed.threads || [], true).slice(0, PORTAL.maxThreads);
  const threads = refreshedRecords.map((record) => threadSummary_(record, email, auditByThreadId[String(record.threadId)] || []));
  threads.sort((a, b) => dateValue_(b.lastMessageAt) - dateValue_(a.lastMessageAt));
  return { ok: true, threads, allowedSenders: Array.from(refreshedAllowedSenders).sort() };
}

function discoverManagedInboundThreads_(allowedSenders, records) {
  const cutoffBySender = {};
  (records || []).forEach((record) => {
    const createdAt = dateValue_(record && record.createdAt);
    if (!createdAt) return;
    extractEmails_(record.recipient).forEach((sender) => {
      if (!allowedSenders.has(sender)) return;
      cutoffBySender[sender] = cutoffBySender[sender] ? Math.min(cutoffBySender[sender], createdAt) : createdAt;
    });
  });
  const senders = Object.keys(cutoffBySender);
  if (!senders.length) return [];

  const existing = {};
  (records || []).forEach((record) => { if (record && record.threadId) existing[String(record.threadId)] = true; });
  const candidateThreadIds = {};
  const timeZone = Session.getScriptTimeZone() || 'Etc/UTC';
  // GmailApp.search is deliberately used here instead of relying only on the
  // Advanced Gmail Threads.list response. Some automatic replies are placed
  // in a new thread, and GmailApp.search consistently returns those Inbox
  // threads even when their subject/thread headers do not match the sent mail.
  senders.forEach((sender) => {
    const after = Utilities.formatDate(new Date(cutoffBySender[sender]), timeZone, 'yyyy/MM/dd');
    try {
      GmailApp.search('from:' + sender + ' after:' + after, 0, 50).forEach((thread) => {
        if (thread && thread.getId()) candidateThreadIds[String(thread.getId())] = true;
      });
    } catch (ignored) {}
  });

  const discovered = [];
  Object.keys(candidateThreadIds).forEach((threadId) => {
    if (discovered.length >= PORTAL.maxThreads || existing[threadId]) return;
    try {
      const thread = Gmail.Users.Threads.get('me', threadId, { format: 'full' });
      const candidate = (thread.messages || [])
        .map((message) => ({ message, sender: addressFrom_(header_(message, 'From')), at: Number(message.internalDate || 0) || dateValue_(header_(message, 'Date')) }))
        .filter((entry) => allowedSenders.has(entry.sender) && entry.at > (cutoffBySender[entry.sender] || 0))
        .sort((a, b) => b.at - a.at)[0];
      if (!candidate) return;
      existing[threadId] = true;
      discovered.push({
        threadId,
        recipient: candidate.sender,
        createdAt: new Date(candidate.at).toISOString(),
        lastSeenAt: new Date(candidate.at).toISOString(),
      });
    } catch (ignored) {
      // Ignore one unavailable or malformed thread and continue with the list.
    }
  });
  return discovered;
}

function getManagedThread(sessionToken, threadId) {
  const email = backendEmail_();
  const id = cleanText_(threadId, 160);
  if (!id) throw new Error('Choose a conversation first.');
  const snapshot = portalMailboxSnapshot_(email, sessionToken);
  const allowedSenders = new Set(snapshot.allowedSenders || []);
  const records = (snapshot.threads || []).filter((record) => record && String(record.threadId) === id);
  let record = records.length ? records[0] : null;
  let audits = (snapshot.messages || []).filter((audit) => audit && String(audit.threadId || '') === id);
  // Mailbox snapshots contain complete short bodies. Only fetch the full
  // thread audit when a preview was actually truncated; this keeps normal
  // short sent messages instant while preserving complete long messages.
  const needsFullAudit = audits.some((audit) => String(audit.body || '').length >= 260);
  if (record && audits.length && needsFullAudit) {
    try { audits = loggerCall_('threadMessages', { email, sessionToken, threadId: id }); } catch (ignored) {}
  }
  const hasBlankReceivedAudit = audits.some((audit) => String(audit.direction || '').toLowerCase() === 'received' && !String(audit.body || '').trim());
  const hasAttachmentAudit = audits.some((audit) => {
    const metadata = String(audit.attachmentMetadata || '').trim();
    return Boolean(metadata && metadata !== '[]');
  });
  // Portal-sent messages are already privacy-filtered and stored in the
  // private Sheet logger. Use that copy immediately instead of waiting on a
  // second Gmail payload request just to open a sent conversation.
  if (record && audits.length && !hasBlankReceivedAudit && !hasAttachmentAudit) return { ok: true, thread: threadViewFromAudits_(email, record, audits, allowedSenders) };
  // A discovered Inbox thread has no portal audit row by design. Fetch its
  // complete Gmail payload once now so opening it shows the actual sender,
  // headers, body, and safe attachment metadata immediately. The previous
  // path returned a placeholder and then made a second slow GmailApp call.
  if (record && (record.inbound || hasBlankReceivedAudit || hasAttachmentAudit)) {
    const thread = Gmail.Users.Threads.get('me', id, { format: 'full' });
    const view = threadView_(thread, email, record, allowedSenders, groupAuditsByMessage_(audits));
    cacheManagedThreadMessages_(email, sessionToken, view, audits);
    return { ok: true, thread: view };
  }
  if (record) {
    const summary = threadSummary_(record, email, []);
    summary.needsRemoteCheck = true;
    summary.messageCount = 0;
    return { ok: true, thread: summary };
  }
  throw new Error('That conversation was not started with a portal send.');
}

function getManagedThreadRemote(sessionToken, threadId) {
  const email = backendEmail_();
  const id = cleanText_(threadId, 160);
  if (!id) throw new Error('Choose a conversation first.');
  const snapshot = portalMailboxSnapshot_(email, sessionToken);
  const allowedSenders = new Set(snapshot.allowedSenders || []);
  let record = (snapshot.threads || []).find((item) => item && String(item.threadId) === id) || null;
  let audits = (snapshot.messages || []).filter((audit) => audit && String(audit.threadId || '') === id);
  if (audits.length) {
    try { audits = loggerCall_('threadMessages', { email, sessionToken, threadId: id }); } catch (ignored) {}
  }
  if (!record) throw new Error('That conversation was not started with a portal send.');
  const gmailThread = GmailApp.getThreadById(id);
  if (!gmailThread) throw new Error('The Gmail conversation could not be found.');
  return { ok: true, thread: gmailAppThreadView_(gmailThread, email, record, allowedSenders, groupAuditsByMessage_(audits)) };
}

function cacheManagedThreadMessages_(email, sessionToken, thread, existingAudits) {
  const existing = {};
  (existingAudits || []).forEach((audit) => {
    if (audit && audit.messageId) existing[String(audit.messageId)] = true;
  });
  const messages = (thread && thread.messages || [])
    .filter((message) => message && !message.blocked && message.id && !existing[String(message.id)])
    .map((message) => ({
      direction: message.mine ? 'sent' : 'received',
      action: message.mine ? 'gmail_sync' : 'cache',
      threadId: thread.threadId,
      messageId: message.id,
      from: message.from,
      to: message.to,
      subject: message.subject,
      body: message.body,
      attachmentMetadata: JSON.stringify(message.attachments || []),
    }));
  if (!messages.length) return;
  try { loggerCall_('cacheMessages', { email, sessionToken, messages }); } catch (ignored) {}
  clearPortalMailboxCache_(email, sessionToken);
}

function cacheReceivedThread_(email, sessionToken, thread) {
  cacheManagedThreadMessages_(email, sessionToken, thread, []);
}

function portalMailboxSnapshot_(email, sessionToken) {
  const token = String(sessionToken || '').trim();
  if (!token) throw new Error('Sign in to the teacher portal first.');
  const key = portalMailboxCacheKey_(email, token);
  if (portalMailboxMemory[key]) return portalMailboxMemory[key];
  const cache = CacheService.getScriptCache();
  const cached = cache.get(key);
  if (cached) {
    try {
      const snapshot = JSON.parse(cached);
      portalMailboxMemory[key] = snapshot;
      return snapshot;
    } catch (ignored) {}
  }
  const snapshot = loggerCall_('mailboxSnapshot', { email, sessionToken: token });
  portalMailboxMemory[key] = snapshot;
  try { cache.put(key, JSON.stringify(snapshot), PORTAL_CACHE.mailboxSeconds); } catch (ignored) {}
  return snapshot;
}

function portalMailboxCacheKey_(email, sessionToken) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(email || '').toLowerCase() + '|' + String(sessionToken || ''),
    Utilities.Charset.UTF_8
  );
  const hex = bytes.map((byte) => {
    const normalized = byte < 0 ? byte + 256 : byte;
    return (normalized < 16 ? '0' : '') + normalized.toString(16);
  }).join('');
  return 'teacher-mail-desk:portal-mailbox:' + hex.slice(0, 48);
}

function clearPortalMailboxCache_(email, sessionToken) {
  const key = portalMailboxCacheKey_(email, sessionToken);
  delete portalMailboxMemory[key];
  try { CacheService.getScriptCache().remove(key); } catch (ignored) {}
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
  const hasInbound = threadAudits.some((audit) => String(audit.direction || '').toLowerCase() === 'received');
  const latestInbound = threadAudits.find((audit) => String(audit.direction || '').toLowerCase() === 'received') || null;
  return {
    threadId: record.threadId,
    recipient: String(record.recipient || '').trim(),
    createdAt: String(record.createdAt || ''),
    lastSeenAt: String(record.lastSeenAt || ''),
    lastMessageAt: latest ? String(latest.timestamp || record.lastSeenAt || record.createdAt || '') : String(record.lastSeenAt || record.createdAt || ''),
    sender: latestInbound && latestInbound.from ? addressFrom_(latestInbound.from) : (latest && latest.from ? addressFrom_(latest.from) : String(record.sender || record.recipient || (record.inbound ? 'Allowed sender' : ''))),
    hasInbound: Boolean(record.inbound || hasInbound),
    hasSent,
    subject: latest ? safeDisplayText_(latest.subject || 'Private conversation', 180) : safeDisplayText_(record.subject || (record.inbound ? 'Incoming message' : 'Managed conversation'), 180),
    preview: latest && latest.body ? safeDisplayText_(latest.body, 220) : safeDisplayText_(record.preview || 'Open to load the complete conversation.', 220),
    messageCount: threadAudits.length,
    loaded: false,
    messages: [],
  };
}

function threadViewFromAudits_(email, record, audits, allowedSenders) {
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
  const view = threadView_({ messages }, email, record, allowedSenders || new Set(), grouped);
  view.needsRemoteCheck = !(audits || []).some((audit) => String(audit.direction || '').toLowerCase() === 'received');
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
  const attachments = message.getAttachments({ includeInlineImages: false }).map((file) => ({
    name: safeDisplayText_(file.getName(), 160),
    mimeType: safeDisplayText_(file.getContentType(), 120),
    size: Number(file.getSize() || 0),
  })).slice(0, 20);
  const blocked = hasFinancialPattern_(subject + '\n' + body + '\n' + attachments.map((file) => file.name + ' ' + file.mimeType).join('\n'));
  return {
    id: String(message.getId() || ''),
    blocked,
    attachment: attachments.length > 0,
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
  recordManagedThread_(email, sessionToken, sent.threadId, recipients.join(', '));
  try { loggerCall_('ensureAllowedSenders', { email, sessionToken, senders: recipients }); } catch (ignored) {}
  recordAudit_(email, sessionToken, 'send', sent.threadId, sent.id || '', 'success', '');
  recordMessageAudit_(email, sessionToken, 'sent', 'send', sent.threadId, sent.id || '', email, recipients.join(', '), cleanSubject, cleanBody, safeAttachments);
  forwardAuditCopy_(email, sessionToken, recipients, cleanSubject, cleanBody, sent, safeAttachments);
  clearPortalMailboxCache_(email, sessionToken);
  return { ok: true, sent: true };
}

function replyToThread(sessionToken, threadId, body, attachments) {
  const email = requireSession_(sessionToken);
  const allowed = allowedThreadMap_(email, sessionToken);
  const allowedSenders = allowedSendersFor_(email, sessionToken);
  const id = cleanText_(threadId, 160);
  const record = allowed[id];
  if (!record) throw new Error('That conversation was not started through this portal.');
  const cleanBody = cleanText_(body, PORTAL.maxBodyChars);
  const safeAttachments = normalizeAttachments_(attachments);
  if (!cleanBody) throw new Error('Write a reply before sending.');
  assertSafeContent_(cleanBody);

  const thread = Gmail.Users.Threads.get('me', id, { format: 'full' });
  const inbound = latestInbound_(thread, email);
  if (inbound && !allowedSenders.has(addressFrom_(header_(inbound, 'From')))) {
    recordAudit_(email, sessionToken, 'reply', id, '', 'blocked', 'Inbound sender is not on AllowedSenders.');
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
  recordManagedThread_(email, sessionToken, id, record.recipient);
  recordAudit_(email, sessionToken, 'reply', id, sent && sent.id ? sent.id : '', 'success', '');
  recordMessageAudit_(email, sessionToken, 'sent', 'reply', id, sent && sent.id ? sent.id : '', email, recipient, replySubject, cleanBody, safeAttachments);
  forwardAuditCopy_(email, sessionToken, [recipient], replySubject, cleanBody, sent, safeAttachments);
  clearPortalMailboxCache_(email, sessionToken);
  // Return the just-updated Gmail conversation so the Pages UI can render the
  // sent reply immediately, even if the Sheet logger is briefly cached or
  // unavailable. The next mailbox refresh still persists the audit normally.
  let threadView = null;
  try {
    const refreshed = Gmail.Users.Threads.get('me', id, { format: 'full' });
    threadView = threadView_(refreshed, email, record, allowedSenders, { byMessageId: {}, byThreadId: {} });
  } catch (ignored) {}
  return { ok: true, sent: true, thread: threadView };
}

function forwardMessage(sessionToken, threadId, messageId, to, note, attachments) {
  const email = requireSession_(sessionToken);
  const allowed = allowedThreadMap_(email, sessionToken);
  const id = cleanText_(threadId, 160);
  const record = allowed[id];
  if (!record) throw new Error('That conversation was not started through this portal.');
  const recipients = parseRecipients_(to);
  const thread = Gmail.Users.Threads.get('me', id, { format: 'full' });
  const source = (thread.messages || []).find((message) => String(message.id || '') === cleanText_(messageId, 160));
  if (!source) throw new Error('The selected message could not be found.');
  const sourceFrom = addressFrom_(header_(source, 'From'));
  if (sourceFrom && sourceFrom !== email && !allowedSendersFor_(email, sessionToken).has(sourceFrom)) {
    recordAudit_(email, sessionToken, 'forward', id, source.id || '', 'blocked', 'Inbound sender is not on AllowedSenders.');
    throw new Error('This sender is not on the AllowedSenders list.');
  }
  const sourceSubject = header_(source, 'Subject') || 'Teacher Mail Desk conversation';
  const sourceBody = plainBody_(source.payload);
  const sourceAttachments = attachmentInputsFromMessage_(source);
  if (!sourceBody && !sourceAttachments.length) throw new Error('This message is empty and cannot be forwarded.');
  if (hasFinancialPattern_(sourceSubject + '\n' + sourceBody + '\n' + sourceAttachments.map((file) => file.name + ' ' + file.mimeType).join('\n'))) throw new Error('This message is hidden by the privacy filter and cannot be forwarded.');
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
  const safeAttachments = normalizeAttachments_(sourceAttachments.concat(attachments || []));
  const forwardSubject = /^fwd:/i.test(sourceSubject) ? sourceSubject : 'Fwd: ' + sourceSubject;
  const sent = Gmail.Users.Messages.send({ raw: rawMessage_(recipients, forwardSubject, forwardedBody, [], safeAttachments) }, 'me');
  if (!sent || !sent.threadId) throw new Error('Gmail did not return a thread ID.');
  ensureManagedLabel_();
  addManagedLabel_(sent.threadId);
  recordManagedThread_(email, sessionToken, sent.threadId, recipients.join(', '));
  recordAudit_(email, sessionToken, 'forward', sent.threadId, sent.id || '', 'success', '');
  recordMessageAudit_(email, sessionToken, 'sent', 'forward', sent.threadId, sent.id || '', email, recipients.join(', '), forwardSubject, forwardedBody, safeAttachments);
  forwardAuditCopy_(email, sessionToken, recipients, forwardSubject, forwardedBody, sent, safeAttachments);
  clearPortalMailboxCache_(email, sessionToken);
  return { ok: true, sent: true };
}

function attachmentInputsFromMessage_(message) {
  const result = [];
  const rootPayload = message && message.payload;
  function collect(part) {
    if (!part) return;
    if (part.filename && !isInlinePart_(part, rootPayload)) {
      const name = safeDisplayText_(part.filename, 160);
      const mimeType = safeDisplayText_(part.mimeType, 120) || 'application/octet-stream';
      if (hasFinancialPattern_(name + '\n' + mimeType)) throw new Error('This attachment is hidden by the privacy filter.');
      let data = part.body && part.body.data;
      if (!data && part.body && part.body.attachmentId) {
        const attachment = Gmail.Users.Messages.Attachments.get('me', String(message.id), part.body.attachmentId);
        data = attachment && attachment.data;
      }
      if (!data) throw new Error('One original attachment is not available for forwarding.');
      result.push({ name, mimeType, base64: standardBase64_(data) });
    }
    (part.parts || []).forEach(collect);
  }
  collect(message && message.payload);
  return result;
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
  // These operations are idempotent. Google occasionally returns a short HTML
  // interstitial after the logger has already finished the write, so retrying
  // prevents a successful Gmail send from being reported as failed.
  const retryable = [
    'mailboxSnapshot', 'authorize', 'listThreads', 'listAllowedSenders',
    'recordThread', 'recordThreads', 'ensureAllowedSenders', 'cacheMessages', 'messageAudit',
  ].indexOf(operation) >= 0;
  const maxAttempts = retryable ? 3 : 1;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      });
      let decoded;
      const responseText = String(response.getContentText() || '').replace(/^\uFEFF/, '').trim();
      try { decoded = JSON.parse(responseText); } catch (error) { throw new Error('The private Sheet logger returned an invalid response.'); }
      if (response.getResponseCode() >= 300 || !decoded.ok) throw new Error(decoded.error || 'The private Sheet logger rejected the request.');
      return decoded.result;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) Utilities.sleep(250 * (attempt + 1));
    }
  }
  throw lastError || new Error('The private Sheet logger did not respond.');
}

function recordManagedThread_(email, sessionToken, threadId, recipient) {
  try {
    loggerCall_('recordThread', { email, sessionToken, threadId, recipient });
  } catch (ignored) {
    // Gmail has already sent the message. Keep a small, private retry record
    // in the portal owner's script properties so a later mailbox refresh can
    // complete the Sheet write without showing a false failed-send error.
    queuePendingManagedThread_(email, sessionToken, threadId, recipient);
  }
}

function queuePendingManagedThread_(email, sessionToken, threadId, recipient) {
  const key = pendingManagedThreadsKey_(email, sessionToken);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(3000);
    const props = PropertiesService.getScriptProperties();
    let pending = [];
    try { pending = JSON.parse(String(props.getProperty(key) || '[]')); } catch (ignored) {}
    pending = Array.isArray(pending) ? pending : [];
    const item = { threadId: cleanText_(threadId, 160), recipient: cleanText_(recipient, 500), queuedAt: new Date().toISOString() };
    if (!item.threadId || !item.recipient) return;
    const index = pending.findIndex((entry) => entry && entry.threadId === item.threadId);
    if (index >= 0) pending[index] = item;
    else pending.push(item);
    props.setProperty(key, JSON.stringify(pending.slice(-20)));
  } catch (ignored) {
    // A second future mailbox request will still make the normal logger call.
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function flushPendingManagedThreads_(email, sessionToken) {
  const key = pendingManagedThreadsKey_(email, sessionToken);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(3000);
    const props = PropertiesService.getScriptProperties();
    let pending = [];
    try { pending = JSON.parse(String(props.getProperty(key) || '[]')); } catch (ignored) {}
    pending = Array.isArray(pending) ? pending : [];
    if (!pending.length) return false;
    const remaining = [];
    let wrote = false;
    pending.forEach((item) => {
      try {
        loggerCall_('recordThread', { email, sessionToken, threadId: item.threadId, recipient: item.recipient });
        wrote = true;
      } catch (ignored) {
        remaining.push(item);
      }
    });
    if (remaining.length) props.setProperty(key, JSON.stringify(remaining.slice(-20)));
    else props.deleteProperty(key);
    return wrote;
  } catch (ignored) {
    return false;
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function pendingManagedThreadsKey_(email, sessionToken) {
  return 'PENDING_MANAGED_THREADS_' + portalMailboxCacheKey_(email, sessionToken).slice(-48);
}

function recordAudit_(email, sessionToken, action, threadId, messageId, result, reason) {
  try {
    loggerCall_('audit', { email, sessionToken, action, threadId, messageId, result, reason });
  } catch (ignored) {
    // Do not turn a successful Gmail operation into a duplicate send because
    // an audit write was temporarily unavailable.
  }
}

function recordMessageAudit_(email, sessionToken, direction, action, threadId, messageId, from, to, subject, body, attachments) {
  if (!messageId) return;
  const attachmentMetadata = (attachments || [])
    .map((file) => ({ name: file.name, mimeType: file.mimeType, size: file.size }))
    .map(JSON.stringify)
    .join('\n');
  try {
    loggerCall_('messageAudit', {
      email, sessionToken, direction, action, threadId, messageId, from, to, subject, body, attachmentMetadata, result: 'success',
    });
  } catch (ignored) {
    // Message delivery/read access remains independent of a temporary audit-write outage.
  }
}

function forwardAuditCopy_(email, sessionToken, recipients, subject, body, sent, attachments) {
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
    recordAudit_(email, sessionToken, 'audit_forward', sent && sent.threadId ? sent.threadId : '', forwarded && forwarded.id ? forwarded.id : '', 'success', PORTAL.auditForwardTo);
  } catch (error) {
    recordAudit_(email, sessionToken, 'audit_forward', sent && sent.threadId ? sent.threadId : '', '', 'error', 'Audit copy failed');
  }
}

function allowedThreadMap_(email, sessionToken) {
  const snapshot = sessionToken ? portalMailboxSnapshot_(email, sessionToken) : null;
  const allowedSenders = new Set(snapshot ? (snapshot.allowedSenders || []) : loggerCall_('listAllowedSenders', { email, sessionToken }));
  const records = managedThreadRecords_(email, sessionToken, allowedSenders, snapshot ? snapshot.threads : null, false);
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
  const hasAttachment = hasAttachment_(message.payload, message.payload);
  let body = plainBody_(message.payload) || String(audit && audit.body || '');
  // A few multipart Gmail messages expose attachment metadata but omit the
  // decoded text in the Advanced Gmail payload. Ask GmailApp for the plain
  // text only in that rare empty-body case; normal cached messages never take
  // this path.
  if (!body && message.id) {
    try { body = String(GmailApp.getMessageById(String(message.id)).getPlainBody() || ''); } catch (ignored) {}
  }
  const attachments = attachmentSummaries_(message.payload, audit, String(message.id || ''));
  const attachmentNames = attachments.map((file) => file.name + ' ' + file.mimeType).join('\n');
  if (hasFinancialPattern_(subject + '\n' + body + '\n' + attachmentNames)) {
    return {
      id: message.id,
      blocked: true,
      attachment: hasAttachment || attachments.length > 0,
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
    attachment: hasAttachment || attachments.length > 0,
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

function attachmentSummaries_(payload, audit, messageId) {
  const result = [];
  function collect(part) {
    if (!part) return;
    if (part.filename && !isInlinePart_(part, payload)) result.push({
      name: safeDisplayText_(part.filename, 160),
      mimeType: safeDisplayText_(part.mimeType, 120),
      size: Number(part.body && part.body.size || 0),
      attachmentId: safeDisplayText_(part.body && part.body.attachmentId, 240),
      messageId: safeDisplayText_(messageId, 160),
    });
    (part.parts || []).forEach(collect);
  }
  collect(payload);
  // A real Gmail payload is authoritative. Only use Sheet metadata for
  // synthetic audit-only messages; this prevents old cached inline logos from
  // reappearing as downloadable attachments.
  const syntheticPayload = !payload || (!payload.mimeType && !(payload.parts || []).length && !payload.filename);
  if (!result.length && syntheticPayload && audit && audit.attachmentMetadata) {
    const addParsed = (parsed) => {
      const files = Array.isArray(parsed) ? parsed : [parsed];
      files.forEach((file) => {
        if (!file || !file.name) return;
        result.push({
          name: safeDisplayText_(file.name, 160),
          mimeType: safeDisplayText_(file.mimeType, 120),
          size: Number(file.size || 0),
          attachmentId: safeDisplayText_(file.attachmentId, 240),
          messageId: safeDisplayText_(file.messageId || messageId, 160),
        });
      });
    };
    try {
      addParsed(JSON.parse(String(audit.attachmentMetadata)));
    } catch (ignored) {
      String(audit.attachmentMetadata).split('\n').forEach((line) => {
        try { addParsed(JSON.parse(line)); } catch (ignoredLine) {}
      });
    }
  }
  return result.slice(0, 20);
}

function mimeHeaderValue_(part, name) {
  const headers = (part && part.headers) || [];
  const match = headers.find((header) => String(header && header.name || '').toLowerCase() === name.toLowerCase());
  return String(match && match.value || '');
}

function isInlinePart_(part, rootPayload) {
  const disposition = mimeHeaderValue_(part, 'Content-Disposition');
  if (/^inline\b/i.test(disposition)) return true;
  const contentId = mimeHeaderValue_(part, 'Content-ID').replace(/^<|>$/g, '').trim().toLowerCase();
  if (!contentId) return false;
  // Some Gmail clients label inline signature images as "attachment" but
  // reference them from the HTML/text body with cid:. Keep those images out
  // while allowing a genuine file that merely happens to have a Content-ID.
  return payloadReferencesCid_(rootPayload || part, contentId);
}

function payloadReferencesCid_(payload, contentId) {
  let found = false;
  function scan(part) {
    if (!part || found) return;
    const mimeType = String(part.mimeType || '').toLowerCase();
    if ((mimeType === 'text/plain' || mimeType === 'text/html') && part.body && part.body.data) {
      const text = decodeBase64Url_(part.body.data).toLowerCase();
      if (text.indexOf('cid:' + contentId) >= 0 || text.indexOf('cid:<' + contentId + '>') >= 0) found = true;
    }
    (part.parts || []).forEach(scan);
  }
  scan(payload);
  return found;
}

function findAttachmentPart_(payload, attachmentId, name) {
  if (!payload) return null;
  const partId = String(payload.body && payload.body.attachmentId || '');
  const filename = String(payload.filename || '');
  const sameName = !attachmentId && name && filename && filename.toLowerCase() === name.toLowerCase();
  if ((attachmentId && partId === attachmentId) || sameName) return payload;
  for (const part of (payload.parts || [])) {
    const found = findAttachmentPart_(part, attachmentId, name);
    if (found) return found;
  }
  return null;
}

function standardBase64_(value) {
  const raw = String(value || '').replace(/\s/g, '');
  if (!raw) return '';
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) throw new Error('The attachment data was not valid base64.');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  try {
    return Utilities.base64Encode(Utilities.base64Decode(padded));
  } catch (firstError) {
    try {
      return Utilities.base64Encode(Utilities.base64DecodeWebSafe(padded));
    } catch (ignored) {
      throw new Error('The attachment data could not be decoded.');
    }
  }
}

function downloadAttachment(sessionToken, threadId, messageId, attachmentId, attachmentName) {
  const email = requireSession_(sessionToken);
  const id = cleanText_(threadId, 160);
  const mid = cleanText_(messageId, 160);
  const aid = cleanText_(attachmentId, 240);
  const name = cleanText_(attachmentName, 160);
  if (!id || !mid || (!aid && !name)) throw new Error('The received file could not be identified.');
  const record = allowedThreadMap_(email, sessionToken)[id];
  if (!record) throw new Error('That conversation was not started through this portal.');
  const message = Gmail.Users.Messages.get('me', mid, { format: 'full' });
  if (String(message.threadId || '') !== id) throw new Error('The received file does not belong to this conversation.');
  const sourceFrom = addressFrom_(header_(message, 'From'));
  if (sourceFrom && sourceFrom !== email && !allowedSendersFor_(email, sessionToken).has(sourceFrom)) throw new Error('This sender is not on the AllowedSenders list.');
  const subject = header_(message, 'Subject');
  const body = plainBody_(message.payload);
  const part = findAttachmentPart_(message.payload, aid, '') || findAttachmentPart_(message.payload, '', name);
  if (!part) throw new Error('This received file is no longer available.');
  if (isInlinePart_(part, message.payload)) throw new Error('This image is part of the email design, not a downloadable attachment.');
  if (hasFinancialPattern_(subject + '\n' + body + '\n' + part.filename + '\n' + part.mimeType)) {
    throw new Error('This file is hidden by the privacy filter.');
  }
  let data = part.body && part.body.data;
  if (!data && part.body && part.body.attachmentId) {
    const attachment = Gmail.Users.Messages.Attachments.get('me', mid, part.body.attachmentId);
    data = attachment && attachment.data;
  }
  if (!data) throw new Error('The received file is not available.');
  const base64 = standardBase64_(data);
  const size = Math.floor(base64.length * 3 / 4);
  if (size > PORTAL.maxAttachmentBytes) throw new Error('This file is larger than the portal download limit.');
  return { ok: true, name: safeDisplayText_(part.filename, 160), mimeType: safeDisplayText_(part.mimeType, 120) || 'application/octet-stream', size, base64 };
}

function latestInbound_(thread, accountEmail) {
  const messages = (thread.messages || []).slice().reverse();
  return messages.find((message) => {
    const from = addressFrom_(header_(message, 'From'));
    return from && from.toLowerCase() !== accountEmail.toLowerCase();
  }) || null;
}

function allowedSendersFor_(email, sessionToken) {
  if (sessionToken) return new Set(portalMailboxSnapshot_(email, sessionToken).allowedSenders || []);
  throw new Error('Sign in to the teacher portal first.');
}

function managedThreadRecords_(email, sessionToken, allowedSenders, preloadedRecords, discoverInbound) {
  // The first outbound portal send is the hard boundary. Do not discover or
  // import historical Gmail conversations merely because an address is on the
  // AllowedSenders list; only replies in a recorded portal thread are shown.
  const records = (preloadedRecords || loggerCall_('listThreads', { email, sessionToken }))
    .filter((record) => record && record.threadId && String(record.recipient || '').trim())
    .slice(-100)
    .reverse();
  const byId = {};
  records.forEach((record) => {
    byId[record.threadId] = record;
  });
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
  if (payload.filename) return '';
  const parts = payload.parts || [];
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return decodeBase64Url_(payload.body.data);
  for (const part of parts) {
    const text = plainBody_(part);
    if (text) return text;
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) return stripHtml_(decodeBase64Url_(payload.body.data));
  if (payload.body && payload.body.data) return decodeBase64Url_(payload.body.data);
  return '';
}

function hasAttachment_(payload, rootPayload) {
  if (!payload) return false;
  const root = rootPayload || payload;
  if (payload.filename && !isInlinePart_(payload, root)) return true;
  return (payload.parts || []).some((part) => hasAttachment_(part, root));
}

function decodeBase64Url_(value) {
  try {
    const base64 = standardBase64_(value);
    return Utilities.newBlob(Utilities.base64Decode(base64)).getDataAsString('UTF-8');
  } catch (error) {
    return '';
  }
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
