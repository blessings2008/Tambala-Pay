# Tambala Pay

Internal-first payment collection and financial tracking for Tambala Technologies.

## Scope
This repository is initially for **Tambala Technologies and its internal organization only**. It is not a public multi-merchant payment platform yet.

### MVP capabilities
- Create an invoice once in MWK, with a stable invoice number and customer details.
- Collect partial payments against an invoice, at different times, up to the remaining amount.
- Track invoice total, amount collected, outstanding balance, and each payment attempt separately.
- Issue a unique receipt for every verified successful partial payment.
- Keep the earlier one-off payment request flow available during the transition.
- Create payment requests in MWK.
- Generate unique payment references and hosted PayChangu checkout links.
- Record pending, successful, failed, and cancelled payment states.
- Verify payment status server-side with PayChangu before marking a request paid.
- Receive and validate PayChangu webhooks.
- View transaction history and print a basic receipt.
- Keep credentials in environment variables, never in source control.

## Stack
- Node.js + Express
- Supabase PostgreSQL (server-side connection through `pg`)
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
1. Create a Supabase project and open **Connect** in the project dashboard.
2. Copy the PostgreSQL connection string into `DATABASE_URL`. For a hosted Node.js service such as Render, use the **Session pooler** connection string if the direct database endpoint is not reachable over IPv6; keep SSL enabled.
3. In Supabase SQL Editor, run `supabase/schema.sql` to create the tables and enable row-level security as defense in depth. The server also creates missing tables on startup.
4. Copy `.env.example` to `.env` for local development and set a long random `INTERNAL_ACCESS_TOKEN`. Keep the database password and PayChangu secrets only in server environment variables.
5. Run `npm install`, then `npm start`.
6. Open http://localhost:3000 and enter the internal access token.

The app uses the PostgreSQL wire protocol via the `pg` package; it does not expose the Supabase service/database credential to the browser or require a Supabase publishable key. Existing `payment_requests` records remain supported for backwards compatibility.

## Invoice flow
1. Create an invoice once with the full amount due.
2. From the invoice ledger, choose **Collect payment** and enter any amount from MWK 1 up to the available balance.
3. Tambala Pay generates a QR code for that specific hosted PayChangu checkout. Show it to the customer to scan, download it, or copy the checkout link to send by chat.
4. Repeat later for another partial payment. Each payment is verified independently and receives its own receipt after confirmation.
5. The invoice moves from open to partially paid, then paid once verified payments cover its total.

Pending checkout links reserve their amounts until the provider reports a final state, helping prevent creating payment links that would over-collect an invoice.

## Environment variables
See .env.example. Never commit real credentials.

## Initial limitations
- Internal single-organization access only.
- MWK only in the first pass.
- No automatic payouts, wallets, or custody of funds.
- Payment provider onboarding and live credentials are separate from application development.
- The QR code contains a link to a specific PayChangu checkout, not a direct bank/mobile-money transfer instruction. Generate a fresh QR for each partial-payment checkout.