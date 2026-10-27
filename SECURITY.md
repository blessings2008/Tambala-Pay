# Security notes for the internal MVP

## Access boundary
- This app is intended for Tambala Technologies internal use only.
- The API requires a bearer token for all dashboard and payment-request endpoints.
- The PayChangu webhook and return endpoint are intentionally public so the provider/customer browser can reach them; they must never be used as proof of payment without verification.
- Do not share the internal token in chat, screenshots, client-side source code, or GitHub.
- Use a long randomly generated token (at least 32 characters) and rotate it if it is exposed.
- Store all secrets only in the deployment environment or local .env file.

## Before deployment
1. Change the GitHub repository visibility to **Private** if the code is intended to remain internal.
2. Configure HTTPS and a production APP_BASE_URL.
3. Set DATABASE_URL to a managed PostgreSQL database with a strong database password.
4. Add PayChangu test credentials first and run a complete test transaction.
5. Configure the PayChangu webhook URL as https://YOUR-DOMAIN/api/paychangu/webhook and set the matching webhook secret.
6. Confirm webhook signatures and server-side verification in test mode before using live credentials.
7. Back up the database and restrict database access to the application.
8. Never mark a request paid based only on query parameters, browser redirects, or unverified webhook data.

## Financial correctness
- A receipt is available only after the server verifies the payment reference, amount, currency, and successful status with PayChangu.
- The initial version expects one full payment per request. Partial payments and refunds are not implemented.
- No wallet balance, stored value, or payout functionality is provided.
