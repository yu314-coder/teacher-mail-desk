# Teacher Mail Desk

GitHub Pages is the complete visible frontend. A hidden Apps Script bridge is the core application and the only component that decides which Gmail threads the teacher can send, receive, reply to, or forward.

## Privacy boundary

- The teacher uses only the GitHub Pages screen; they do not need to enter the Apps Script editor, Apps Script mailbox UI, or authorize Gmail. The Apps Script web app executes as the owner, so real sends and reads come from the owner's Gmail.
- The portal account itself uses an account name, password, and administrator access code; no teacher email field is shown. The owner Gmail identity remains inside Apps Script and the private Sheet logger.
- The portal records each successful send as an allowlisted Gmail thread. Inbox reads fetch only those exact thread IDs from the private logger.
- Unrelated Gmail messages, manually labelled messages, raw MIME, and attachments are not exposed in the portal.
- Subjects/bodies with common financial or account-data signals are blocked before sending and hidden when received.
- Outgoing attachments are limited to 5 files and 20 MB total. They are sent to the chosen recipient, but never displayed in the portal or included in the audit copy.
- Every successful send/reply produces a separate plain-text audit copy to `imadmitted@gmail.com` with recipient, subject, body, Gmail IDs, and attachment metadata. This is implemented in the Apps Script portal, not by the Sheet itself. The privacy filter runs before this copy is generated.
- Forwarding is also performed by the backend and creates a real Gmail message; it is recorded as a `forward` event and receives the same audit copy.
- The private Google Sheet stores account/session hashes, allowlisted thread IDs, login lockout state, audit events, privacy-filtered message records, and a `Security` tab containing the salted access-code hash and salt. It never stores the raw access code, Gmail OAuth tokens, plaintext passwords, or attachment bytes.

## Repository layout

- `index.html`, `styles.css`, `frontend.js`: GitHub Pages interface for account entry, send, receive, reply, and forward.
- `apps-script/portal`: hidden Apps Script bridge plus redirect-only web app; deploy as the owner with anonymous access.
- `apps-script/logger`: private Apps Script logger bound to the owner's Google Sheet; deploy as `USER_DEPLOYING`.

## Required setup

1. Create a private Google Sheet in the owner's personal Drive.
2. Create a standalone Apps Script project for `apps-script/logger`. Copy `Code.gs` and `appsscript.json` into the project. In Project Settings, add temporary script properties `SETUP_SHEET_ID` and `SETUP_ACCESS_CODE`, then run `initializeLogger()` once. Copy the generated `LOGGER_SECRET` into a secure temporary note; remove the temporary setup properties are removed automatically.
3. Deploy the logger as a web app executing as the owner and accessible anonymously. The endpoint is protected by `LOGGER_SECRET`; do not publish the URL together with the secret.
4. Create a second standalone Apps Script project for `apps-script/portal`. Copy `Code.gs`, `Index.html`, `Bridge.html`, and `appsscript.json`. In Project Settings, add `LOGGER_URL` and `LOGGER_SECRET`. Ensure the Gmail API is enabled in the linked Cloud project and the Gmail advanced service is enabled for the script. Deploy as a web app executing as the user accessing it, accessible to any signed-in Google user.
5. Put only the teacher portal web-app URL in the root `index.html` and commit the change. Never put the Sheet ID, logger secret, password, access code, OAuth token, or client secret in GitHub Pages.
6. In GitHub repository settings, enable Pages from the `main` branch and the root folder.

The exact Apps Script deployment URLs and the Sheet ID are intentionally not checked in. Apps Script project properties are the credential store for the backend; the Sheet remains a private audit/data store in personal Drive.
