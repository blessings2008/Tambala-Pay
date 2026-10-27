# Tambala Pay

Internal-first payment collection and financial tracking for Tambala Technologies.

## Scope
This repository is initially for **Tambala Technologies and its internal organization only**. It is not a public multi-merchant payment platform yet.

### MVP capabilities
- Create payment requests in MWK.
- Generate unique payment references and hosted PayChangu checkout links.
- Record pending, successful, failed, and cancelled payment states.
- Verify payment status server-side with PayChangu before marking a request paid.
- Receive and validate PayChangu webhooks.
- View transaction history and print a basic receipt.
- Keep credentials in environment variables, never in source control.

## Stack
- Node.js + Express
- PostgreSQL (Supabase or another managed PostgreSQL instance)
- PayChangu Standard Checkout
- Plain HTML/CSS/JavaScript frontend

## Important safety rules
- Use PayChangu test credentials first.
- A browser redirect is not proof of payment.
- Only a server-side verification result can mark a payment successful.
- Do not store card or mobile-money PIN details.
- Keep this service private. Do not onboard external merchants in this version.
- Configure HTTPS and a strong INTERNAL_ACCESS_TOKEN before deployment.
- Set the PayChangu webhook secret according to the PayChangu dashboard/docs.

## Local setup
1. Install Node.js 20 or later and PostgreSQL.
2. Copy .env.example to .env and fill in the values.
3. Run npm install.
4. Run npm start.
5. Open http://localhost:3000 and enter the internal access token.

The server creates its required database tables on startup.

## Environment variables
See .env.example. Never commit real credentials.

## Initial limitations
- Internal single-organization access only.
- MWK only in the first pass.
- No automatic payouts, wallets, or custody of funds.
- Payment provider onboarding and live credentials are separate from application development.