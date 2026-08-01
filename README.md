# Teacher Mail Desk

GitHub Pages is the public frontend shell. Google Apps Script is the core application and the only component that decides which Gmail threads the teacher can send or view.

## Privacy boundary

- The teacher authorizes the Apps Script portal with their own Google account; the owner's Gmail is not used. The portal account itself uses an account name, password, and administrator access code; the Google email is only the private Gmail binding.
- The portal records each successful send as an allowlisted Gmail thread. Inbox reads fetch only those exact thread IDs from the private logger.
- Unrelated Gmail messages, manually labelled messages, raw MIME, and attachments are not exposed in the portal.
- Subjects/bodies with common financial or account-data signals are blocked before sending and hidden when received.
- Outgoing attachments are limited to 5 files and 20 MB total. They are sent to the chosen recipient, but never displayed in the portal or included in the audit copy.
- Every successful send/reply produces a separate plain-text audit copy to `imadmitted@gmail.com` with recipient, subject, body, Gmail IDs, and attachment metadata. This is implemented in the Apps Script portal, not by the Sheet itself. The privacy filter runs before this copy is generated.
- The private Google Sheet stores account/session hashes, allowlisted thread IDs, login lockout state, audit events, and privacy-filtered message records handled by the portal. It never stores Gmail OAuth tokens, plaintext passwords/access codes, or attachment bytes.

## Repository layout

- `index.html`, `styles.css`: GitHub Pages shell.
- `apps-script/portal`: teacher-facing Apps Script web app; deploy as `USER_ACCESSING`.
- `apps-script/logger`: private Apps Script logger bound to the owner's Google Sheet; deploy as `USER_DEPLOYING`.

## Required setup

1. Create a private Google Sheet in the owner's personal Drive.
2. Create a standalone Apps Script project for `apps-script/logger`. Copy `Code.gs` and `appsscript.json` into the project. In Project Settings, add temporary script properties `SETUP_SHEET_ID` and `SETUP_ACCESS_CODE`, then run `initializeLogger()` once. Copy the generated `LOGGER_SECRET` into a secure temporary note; remove the temporary setup properties are removed automatically.
3. Deploy the logger as a web app executing as the owner and accessible anonymously. The endpoint is protected by `LOGGER_SECRET`; do not publish the URL together with the secret.
4. Create a second standalone Apps Script project for `apps-script/portal`. Copy `Code.gs`, `Index.html`, and `appsscript.json`. In Project Settings, add `LOGGER_URL` and `LOGGER_SECRET`. Ensure the Gmail API is enabled in the linked Cloud project and the Gmail advanced service is enabled for the script. Deploy as a web app executing as the user accessing it, accessible to any signed-in Google user.
5. Put only the teacher portal web-app URL in the root `index.html` and commit the change. Never put the Sheet ID, logger secret, password, access code, OAuth token, or client secret in GitHub Pages.
6. In GitHub repository settings, enable Pages from the `main` branch and the root folder.

The exact Apps Script deployment URLs and the Sheet ID are intentionally not checked in. Apps Script project properties are the credential store for the backend; the Sheet remains a private audit/data store in personal Drive.
