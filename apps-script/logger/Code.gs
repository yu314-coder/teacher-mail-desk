/**
 * Private Sheet logger for Teacher Mail Desk.
 *
 * Deploy this project as a web app executing as the owner, accessible to
 * anyone (anonymous). It is only callable by the teacher portal's server-side
 * UrlFetchApp request because every request must include LOGGER_SECRET.
 *
 * The logger stores only privacy-filtered message text from portal-handled
 * messages. It never stores attachment bytes, Gmail tokens, or plaintext
 * passwords/access codes.
 */

const LOGGER_SHEETS = {
  users: { name: 'Users', headers: ['accountName', 'email', 'salt', 'passwordHash', 'status', 'createdAt', 'lastLoginAt'] },
  sessions: { name: 'Sessions', headers: ['sessionHash', 'email', 'createdAt', 'expiresAt', 'lastUsedAt', 'status'] },
  threads: { name: 'AllowedThreads', headers: ['email', 'threadId', 'recipient', 'createdAt', 'lastSeenAt', 'status'] },
  allowedSenders: { name: 'AllowedSenders', headers: ['email', 'status', 'addedAt', 'notes'] },
  audit: { name: 'Audit', headers: ['timestamp', 'email', 'action', 'threadId', 'messageId', 'result', 'reason'] },
  messages: { name: 'Messages', headers: ['timestamp', 'email', 'direction', 'action', 'threadId', 'messageId', 'from', 'to', 'subject', 'body', 'attachmentMetadata', 'result'] },
  authAttempts: { name: 'AuthAttempts', headers: ['email', 'windowStartedAt', 'failedCount', 'lockedUntil', 'lastAttemptAt'] },
  security: { name: 'Security', headers: ['setting', 'value'] },
};

let loggerBookCache = null;

/**
 * One-time setup helper.
 *
 * Before running this function from the Apps Script editor, add temporary
 * script properties named SETUP_SHEET_ID and SETUP_ACCESS_CODE in Project
 * Settings. The function deletes both temporary values after setup and
 * generates the private LOGGER_SECRET and password pepper.
 */
function initializeLogger() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = String(props.getProperty('SETUP_SHEET_ID') || '').trim();
  const accessCode = String(props.getProperty('SETUP_ACCESS_CODE') || '').trim();
  if (!sheetId || !accessCode) {
    throw new Error('Set SETUP_SHEET_ID and SETUP_ACCESS_CODE in Project Settings first.');
  }
  if (accessCode.length < 4) {
    throw new Error('SETUP_ACCESS_CODE must be at least 4 characters.');
  }

  const accessSalt = Utilities.getUuid();
  const loggerSecret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const hashPepper = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperties({
    SHEET_ID: sheetId,
    LOGGER_SECRET: loggerSecret,
    HASH_PEPPER: hashPepper,
    ACCESS_CODE_SALT: accessSalt,
    ACCESS_CODE_HASH: hashWithPepper_(accessCode, accessSalt, hashPepper),
    CONFIGURED_AT: new Date().toISOString(),
  }, true);
  props.deleteProperty('SETUP_SHEET_ID');
  props.deleteProperty('SETUP_ACCESS_CODE');
  ensureSheets_();
  setSecurityValue_('ACCESS_CODE_SALT', accessSalt);
  setSecurityValue_('ACCESS_CODE_HASH', hashWithPepper_(accessCode, accessSalt, hashPepper));
  setSecurityValue_('CONFIGURED_AT', new Date().toISOString());
  return {
    ok: true,
    message: 'Logger initialized. Copy LOGGER_SECRET into the portal project properties, then deploy both projects.',
    loggerSecret,
  };
}

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    requireSecret_(payload.secret);
    const result = handleOperation_(String(payload.operation || ''), payload);
    return json_({ ok: true, result });
  } catch (error) {
    return json_({ ok: false, error: publicError_(error) });
  }
}

function doGet() {
  ensureSheets_();
  return json_({ ok: true, service: 'Teacher Mail Desk logger', status: 'private' });
}

function handleOperation_(operation, payload) {
  ensureSheets_();
  switch (operation) {
    case 'sessionState': return sessionState_(payload);
    case 'register': return register_(payload);
    case 'login': return login_(payload);
    case 'logout': return logout_(payload);
    case 'authorize': return authorize_(payload);
    case 'recordThread': return recordThread_(payload);
    case 'listThreads': return listThreads_(payload);
    case 'listAllowedSenders': return listAllowedSenders_(payload);
    case 'audit': return recordAudit_(payload);
    case 'messageAudit': return messageAudit_(payload);
    default: throw new Error('Unknown logger operation.');
  }
}

function sessionState_(payload) {
  const email = normalizedEmail_(payload.email);
  const user = findUserByEmail_(email);
  return { registered: Boolean(user && user.status === 'active') };
}

function register_(payload) {
  const accountName = normalizedAccountName_(payload.accountName);
  const email = normalizedEmail_(payload.email);
  const password = String(payload.password || '');
  const accessCode = String(payload.accessCode || '');
  if (password.length < 6) throw new Error('Use a password with at least 6 characters.');
  if (accessCode.length < 4) throw new Error('The access code is invalid.');
  if (findUserByAccountName_(accountName)) throw new Error('This account name is already registered.');
  if (findUserByEmail_(email)) throw new Error('This Google account is already registered.');
  verifyAccessCode_(accessCode);

  const salt = Utilities.getUuid();
  const passwordHash = hash_(password, salt);
  const sheet = sheetFor_('users');
  sheet.appendRow([accountName, email, salt, passwordHash, 'active', new Date(), '']);
  sheetFor_('audit').appendRow([new Date(), email, 'register', '', '', 'success', '']);
  return createSession_(email);
}

function login_(payload) {
  const accountName = normalizedAccountName_(payload.accountName);
  const email = normalizedEmail_(payload.email);
  const password = String(payload.password || '');
  const accessCode = String(payload.accessCode || '');
  enforceLoginRateLimit_(email);
  const user = findUserByAccountName_(accountName);
  if (!user || user.email !== email || user.status !== 'active') {
    recordLoginFailure_(email);
    throw new Error('No active account exists for this account name and Google account.');
  }
  if (password.length < 6) {
    recordLoginFailure_(email);
    throw new Error('The password is incorrect.');
  }
  if (hash_(password, user.salt) !== user.passwordHash) {
    recordLoginFailure_(email);
    throw new Error('The password is incorrect.');
  }
  try {
    verifyAccessCode_(accessCode);
  } catch (error) {
    recordLoginFailure_(email);
    throw error;
  }
  clearLoginFailures_(email);
  updateRow_(sheetFor_('users'), user.row, user.headers, { lastLoginAt: new Date() });
  sheetFor_('audit').appendRow([new Date(), email, 'login', '', '', 'success', '']);
  return createSession_(email);
}

function verifyAccessCode_(accessCode) {
  if (accessCode.length < 4) throw new Error('The access code is invalid.');
  const props = PropertiesService.getScriptProperties();
  const salt = securityValue_('ACCESS_CODE_SALT') || String(props.getProperty('ACCESS_CODE_SALT') || '');
  const expected = securityValue_('ACCESS_CODE_HASH') || String(props.getProperty('ACCESS_CODE_HASH') || '');
  if (hash_(accessCode, salt) !== expected) {
    throw new Error('The access code is invalid.');
  }
}

function enforceLoginRateLimit_(email) {
  const row = readRows_(sheetFor_('authAttempts')).find((item) => item.email === email);
  if (row && row.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now()) {
    throw new Error('Too many failed sign-in attempts. Try again in 15 minutes.');
  }
}

function recordLoginFailure_(email) {
  const sheet = sheetFor_('authAttempts');
  const existing = readRows_(sheet).find((item) => item.email === email);
  const now = new Date();
  const sameWindow = Boolean(existing && existing.windowStartedAt && Date.now() - new Date(existing.windowStartedAt).getTime() < 15 * 60 * 1000);
  const windowStart = sameWindow
    ? new Date(existing.windowStartedAt)
    : now;
  const count = sameWindow ? Number(existing.failedCount || 0) + 1 : 1;
  const lockedUntil = count >= 5 ? new Date(now.getTime() + 15 * 60 * 1000) : '';
  if (existing) {
    updateRow_(sheet, existing.row, existing.headers, { windowStartedAt: windowStart, failedCount: count, lockedUntil, lastAttemptAt: now });
  } else {
    sheet.appendRow([email, windowStart, count, lockedUntil, now]);
  }
}

function clearLoginFailures_(email) {
  const sheet = sheetFor_('authAttempts');
  const existing = readRows_(sheet).find((item) => item.email === email);
  if (existing) updateRow_(sheet, existing.row, existing.headers, { failedCount: 0, lockedUntil: '', lastAttemptAt: new Date() });
}

function authorize_(payload) {
  const email = normalizedEmail_(payload.email);
  const token = String(payload.sessionToken || '');
  if (token.length < 24) throw new Error('The portal session has expired.');
  const sessionSheet = sheetFor_('sessions');
  const rows = readRows_(sessionSheet);
  const sessionHash = hash_(token, 'session');
  const now = Date.now();
  for (const row of rows) {
    if (row.sessionHash !== sessionHash || row.email !== email || row.status !== 'active') continue;
    if (!row.expiresAt || new Date(row.expiresAt).getTime() <= now) {
      updateRow_(sessionSheet, row.row, row.headers, { status: 'expired' });
      throw new Error('The portal session has expired.');
    }
    updateRow_(sessionSheet, row.row, row.headers, { lastUsedAt: new Date() });
    return { authorized: true };
  }
  throw new Error('The portal session is not valid.');
}

function logout_(payload) {
  const email = normalizedEmail_(payload.email);
  const token = String(payload.sessionToken || '');
  if (token.length < 24) return { loggedOut: true };
  const sessionHash = hash_(token, 'session');
  const row = readRows_(sheetFor_('sessions')).find((item) => item.sessionHash === sessionHash && item.email === email && item.status === 'active');
  if (row) updateRow_(sheetFor_('sessions'), row.row, row.headers, { status: 'revoked', lastUsedAt: new Date() });
  return { loggedOut: true };
}

function recordThread_(payload) {
  const email = normalizedEmail_(payload.email);
  const threadId = cleanText_(payload.threadId, 160);
  const recipient = cleanText_(payload.recipient, 500);
  if (!threadId) throw new Error('A Gmail thread ID is required.');
  if (!recipient) throw new Error('A recipient is required.');
  const sheet = sheetFor_('threads');
  const existing = readRows_(sheet).find((row) => row.email === email && row.threadId === threadId);
  if (existing) {
    updateRow_(sheet, existing.row, existing.headers, { lastSeenAt: new Date(), status: 'active' });
  } else {
    sheet.appendRow([email, threadId, recipient, new Date(), new Date(), 'active']);
  }
  return { recorded: true };
}

function listThreads_(payload) {
  const email = normalizedEmail_(payload.email);
  return readRows_(sheetFor_('threads'))
    .filter((row) => row.email === email && row.status === 'active')
    .slice(-100)
    .reverse()
    .map((row) => ({ threadId: row.threadId, recipient: row.recipient, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt }));
}

function listAllowedSenders_(payload) {
  // The portal supplies its owner account email with every logger call. This
  // keeps the operation tied to the configured backend identity while the
  // actual allowlist remains manually editable in Google Sheets.
  normalizedEmail_(payload.email);
  const seen = {};
  return readRows_(sheetFor_('allowedSenders'))
    .filter((row) => allowedSenderStatus_(row.status))
    .map((row) => senderEmail_(row.email))
    .filter((email) => email && !seen[email] && (seen[email] = true));
}

function allowedSenderStatus_(value) {
  const status = String(value || '').trim().toLowerCase();
  return status !== 'inactive' && status !== 'disabled' && status !== 'removed' && status !== 'blocked';
}

function senderEmail_(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/<([^>]+)>/);
  const email = (match ? match[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : '';
}

function recordAudit_(payload) {
  const email = normalizedEmail_(payload.email);
  const action = cleanText_(payload.action, 80);
  const threadId = cleanText_(payload.threadId, 160);
  const messageId = cleanText_(payload.messageId, 160);
  const result = cleanText_(payload.result, 40);
  const reason = cleanText_(payload.reason, 160);
  if (!action || !result) throw new Error('Audit action and result are required.');
  sheetFor_('audit').appendRow([new Date(), email, action, threadId, messageId, result, reason]);
  return { recorded: true };
}

function messageAudit_(payload) {
  const email = normalizedEmail_(payload.email);
  const direction = cleanText_(payload.direction, 20);
  const action = cleanText_(payload.action, 40);
  const threadId = cleanText_(payload.threadId, 160);
  const messageId = cleanText_(payload.messageId, 160);
  const from = cleanText_(payload.from, 500);
  const to = cleanText_(payload.to, 500);
  const subject = cleanText_(payload.subject, 180);
  const body = cleanText_(payload.body, 48000);
  const attachmentMetadata = cleanText_(payload.attachmentMetadata, 4000);
  const result = cleanText_(payload.result, 40) || 'success';
  if (!direction || !action || !threadId || !messageId) throw new Error('Message audit identifiers are required.');
  if (hasFinancialPattern_(subject + '\n' + body + '\n' + attachmentMetadata)) {
    throw new Error('Message audit content was blocked by the privacy filter.');
  }

  const sheet = sheetFor_('messages');
  const existing = readRows_(sheet).find((row) => row.email === email && row.messageId === messageId && row.direction === direction);
  const values = { timestamp: new Date(), email, direction, action, threadId, messageId, from, to, subject, body, attachmentMetadata, result };
  if (existing) {
    updateRow_(sheet, existing.row, existing.headers, values);
  } else {
    sheet.appendRow([values.timestamp, values.email, values.direction, values.action, values.threadId, values.messageId, values.from, values.to, values.subject, values.body, values.attachmentMetadata, values.result]);
  }
  return { recorded: true };
}

function createSession_(email) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const nowIso = now.toISOString();
  const expiresIso = expires.toISOString();
  sheetFor_('sessions').appendRow([hash_(token, 'session'), email, nowIso, expiresIso, nowIso, 'active']);
  return { authenticated: true, sessionToken: token, expiresAt: expires.toISOString() };
}

function findUserByAccountName_(accountName) {
  return readRows_(sheetFor_('users')).find((row) => row.accountName === accountName) || null;
}

function findUserByEmail_(email) {
  return readRows_(sheetFor_('users')).find((row) => row.email === email) || null;
}

function ensureSheets_() {
  Object.keys(LOGGER_SHEETS).forEach((key) => sheetFor_(key));
  migrateSecurityProperties_();
}

function sheetFor_(key) {
  const config = LOGGER_SHEETS[key];
  if (!config) throw new Error('Unknown Sheet table.');
  const props = PropertiesService.getScriptProperties();
  const id = String(props.getProperty('SHEET_ID') || '').trim();
  if (!id) throw new Error('Logger is not initialized.');
  const book = loggerBookCache || (loggerBookCache = SpreadsheetApp.openById(id));
  let sheet = book.getSheetByName(config.name);
  if (!sheet) sheet = book.insertSheet(config.name);
  if (key === 'users') migrateUsersSchema_(sheet);
  else if (sheet.getLastRow() === 0) sheet.appendRow(config.headers);
  return sheet;
}

function migrateUsersSchema_(sheet) {
  const targetHeaders = LOGGER_SHEETS.users.headers;
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(targetHeaders);
    return;
  }
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), targetHeaders.length)).getValues()[0].map(String);
  const legacy = ['email', 'displayName', 'salt', 'passwordHash', 'status', 'createdAt', 'lastLoginAt'];
  if (headers.slice(0, legacy.length).join('|') === legacy.join('|')) {
    const rowCount = sheet.getLastRow() - 1;
    if (rowCount > 0) {
      const rows = sheet.getRange(2, 1, rowCount, legacy.length).getValues();
      sheet.getRange(2, 1, rowCount, targetHeaders.length).setValues(rows.map((row) => [row[1], row[0], row[2], row[3], row[4], row[5], row[6]]));
    }
    sheet.getRange(1, 1, 1, targetHeaders.length).setValues([targetHeaders]);
  }
}

function migrateSecurityProperties_() {
  const props = PropertiesService.getScriptProperties();
  const salt = String(props.getProperty('ACCESS_CODE_SALT') || '').trim();
  const hash = String(props.getProperty('ACCESS_CODE_HASH') || '').trim();
  if (!salt || !hash) return;
  if (!securityValue_('ACCESS_CODE_SALT')) setSecurityValue_('ACCESS_CODE_SALT', salt);
  if (!securityValue_('ACCESS_CODE_HASH')) setSecurityValue_('ACCESS_CODE_HASH', hash);
  const configuredAt = String(props.getProperty('CONFIGURED_AT') || '').trim();
  if (configuredAt && !securityValue_('CONFIGURED_AT')) setSecurityValue_('CONFIGURED_AT', configuredAt);
}

function securityValue_(setting) {
  const row = readRows_(sheetFor_('security')).find((item) => item.setting === setting);
  return row ? String(row.value || '') : '';
}

function setSecurityValue_(setting, value) {
  const sheet = sheetFor_('security');
  const existing = readRows_(sheet).find((item) => item.setting === setting);
  if (existing) updateRow_(sheet, existing.row, existing.headers, { value: String(value || '') });
  else sheet.appendRow([setting, String(value || '')]);
}

function readRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0].map(String);
  return values.slice(1).map((valuesRow, index) => {
    const row = { row: index + 2, headers };
    headers.forEach((header, column) => { row[header] = valuesRow[column]; });
    return row;
  });
}

function updateRow_(sheet, rowNumber, headers, updates) {
  const current = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  Object.keys(updates).forEach((key) => {
    const column = headers.indexOf(key);
    if (column >= 0) current[column] = updates[key];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([current]);
}

function parsePayload_(e) {
  const body = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  const payload = JSON.parse(body);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid request.');
  return payload;
}

function requireSecret_(provided) {
  const expected = String(PropertiesService.getScriptProperties().getProperty('LOGGER_SECRET') || '');
  const actual = String(provided || '');
  if (!expected || actual.length !== expected.length || !constantTimeEqual_(actual, expected)) {
    throw new Error('Unauthorized logger request.');
  }
}

function constantTimeEqual_(a, b) {
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return result === 0;
}

function normalizedEmail_(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('A valid Google account email is required.');
  return email;
}

function normalizedAccountName_(value) {
  const accountName = cleanText_(value, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(accountName)) {
    throw new Error('Use an account name with 3-80 letters, numbers, dots, hyphens, or underscores.');
  }
  return accountName;
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

function cleanText_(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

function hash_(value, salt) {
  const pepper = String(PropertiesService.getScriptProperties().getProperty('HASH_PEPPER') || '');
  return hashWithPepper_(value, salt, pepper);
}

function hashWithPepper_(value, salt, pepper) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pepper + salt + value, Utilities.Charset.UTF_8);
  return bytes.map((byte) => {
    const normalized = byte < 0 ? byte + 256 : byte;
    return (normalized < 16 ? '0' : '') + normalized.toString(16);
  }).join('');
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function publicError_(error) {
  const message = error && error.message ? error.message : 'Request failed.';
  return message.slice(0, 220);
}
