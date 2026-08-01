/**
 * Private Sheet logger for Teacher Mail Desk.
 *
 * Deploy this project as a web app executing as the owner, accessible to
 * anyone (anonymous). It is only callable by the teacher portal's server-side
 * UrlFetchApp request because every request must include LOGGER_SECRET.
 *
 * The logger deliberately never accepts message subjects, message bodies,
 * attachments, Gmail tokens, or plaintext passwords for storage.
 */

const LOGGER_SHEETS = {
  users: { name: 'Users', headers: ['email', 'displayName', 'salt', 'passwordHash', 'status', 'createdAt', 'lastLoginAt'] },
  sessions: { name: 'Sessions', headers: ['sessionHash', 'email', 'createdAt', 'expiresAt', 'lastUsedAt', 'status'] },
  threads: { name: 'AllowedThreads', headers: ['email', 'threadId', 'recipient', 'createdAt', 'lastSeenAt', 'status'] },
  audit: { name: 'Audit', headers: ['timestamp', 'email', 'action', 'threadId', 'messageId', 'result', 'reason'] },
};

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
  if (accessCode.length < 12) {
    throw new Error('SETUP_ACCESS_CODE must be at least 12 characters.');
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
  return json_({ ok: true, service: 'Teacher Mail Desk logger', status: 'private' });
}

function handleOperation_(operation, payload) {
  ensureSheets_();
  switch (operation) {
    case 'sessionState': return sessionState_(payload);
    case 'register': return register_(payload);
    case 'login': return login_(payload);
    case 'authorize': return authorize_(payload);
    case 'recordThread': return recordThread_(payload);
    case 'listThreads': return listThreads_(payload);
    case 'audit': return recordAudit_(payload);
    default: throw new Error('Unknown logger operation.');
  }
}

function sessionState_(payload) {
  const email = normalizedEmail_(payload.email);
  const user = findUser_(email);
  return { registered: Boolean(user && user.status === 'active') };
}

function register_(payload) {
  const email = normalizedEmail_(payload.email);
  const displayName = cleanText_(payload.displayName, 80);
  const password = String(payload.password || '');
  const accessCode = String(payload.accessCode || '');
  if (!displayName) throw new Error('A display name is required.');
  if (password.length < 12) throw new Error('Use a password with at least 12 characters.');
  if (accessCode.length < 12) throw new Error('The access code is invalid.');
  if (findUser_(email)) throw new Error('This Google account is already registered.');
  const props = PropertiesService.getScriptProperties();
  if (hash_(accessCode, String(props.getProperty('ACCESS_CODE_SALT') || '')) !== props.getProperty('ACCESS_CODE_HASH')) {
    throw new Error('The access code is invalid.');
  }

  const salt = Utilities.getUuid();
  const passwordHash = hash_(password, salt);
  const sheet = sheetFor_('users');
  sheet.appendRow([email, displayName, salt, passwordHash, 'active', new Date(), '']);
  return createSession_(email);
}

function login_(payload) {
  const email = normalizedEmail_(payload.email);
  const password = String(payload.password || '');
  const user = findUser_(email);
  if (!user || user.status !== 'active') throw new Error('No active portal account exists for this Google account.');
  if (hash_(password, user.salt) !== user.passwordHash) throw new Error('The password is incorrect.');
  updateRow_(sheetFor_('users'), user.row, user.headers, { lastLoginAt: new Date() });
  return createSession_(email);
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

function createSession_(email) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const now = new Date();
  const expires = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  sheetFor_('sessions').appendRow([hash_(token, 'session'), email, now, expires, now, 'active']);
  return { authenticated: true, sessionToken: token, expiresAt: expires.toISOString() };
}

function findUser_(email) {
  return readRows_(sheetFor_('users')).find((row) => row.email === email) || null;
}

function ensureSheets_() {
  Object.keys(LOGGER_SHEETS).forEach((key) => sheetFor_(key));
}

function sheetFor_(key) {
  const config = LOGGER_SHEETS[key];
  if (!config) throw new Error('Unknown Sheet table.');
  const props = PropertiesService.getScriptProperties();
  const id = String(props.getProperty('SHEET_ID') || '').trim();
  if (!id) throw new Error('Logger is not initialized.');
  const book = SpreadsheetApp.openById(id);
  let sheet = book.getSheetByName(config.name);
  if (!sheet) sheet = book.insertSheet(config.name);
  if (sheet.getLastRow() === 0) sheet.appendRow(config.headers);
  return sheet;
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
