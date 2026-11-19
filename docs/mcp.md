# Tambala Pay MCP API

Tambala Pay exposes its organization-facing operations through one stateless Model Context Protocol (MCP) endpoint.

## Connection

- Transport: Streamable HTTP, stateless JSON-RPC
- Method: `POST`
- Endpoint: `https://tambala-pay.onrender.com/mcp`
- Protocol version: `2025-03-26`
- Content type: `application/json`
- Authentication: `Authorization: Bearer <INTERNAL_ACCESS_TOKEN>`

Store the token in the organization's server-side secret manager. Do not put it in browser code, public configuration, prompts, or client-side MCP settings.

## Initialize

Send:

```http
POST /mcp
Authorization: Bearer <INTERNAL_ACCESS_TOKEN>
Content-Type: application/json
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": { "name": "tambala-organization", "version": "1.0.0" }
  }
}
```

Then send the `notifications/initialized` notification (no response body is needed). Use `tools/list` to discover the available tools and `tools/call` to execute one.

## List tools

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

## Available tools

| Tool | Arguments | Purpose |
|---|---|---|
| `get_payment_summary` | none | Aggregate counts and MWK collected/pending totals |
| `list_invoices` | none | Latest invoices (up to 250) |
| `create_invoice` | `description`, `totalAmount`; optional `customerName`, `customerEmail`, `recurringMonthly`, `billingStartDate` | Create a one-time or monthly contract invoice |
| `get_invoice` | `id` | Invoice details and payment attempts |
| `create_invoice_payment` | `id`, `amount` | Create a partial-payment checkout |
| `get_payment` | `txRef` | Find a payment by transaction reference |
| `list_payment_requests` | optional `limit` (1–250; default 100) | List legacy one-off payment requests |
| `create_payment_request` | `description`, `amount`; optional `customerName`, `customerEmail` | Create a one-off checkout request |
| `get_invoice_payment_receipt` | `id` | Retrieve receipt for a verified invoice payment |
| `get_payment_request_receipt` | `id` | Retrieve receipt for a verified one-off request |

## Call a tool

Example: get the payment summary.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_payment_summary",
    "arguments": {}
  }
}
```

Example: create an invoice.

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "create_invoice",
    "arguments": {
      "description": "Website development",
      "customerName": "Example Customer",
      "customerEmail": "customer@example.com",
      "totalAmount": 150000
    }
  }
}
```

## cURL example

```bash
curl -X POST "https://tambala-pay.onrender.com/mcp" \
  -H "Authorization: Bearer $TAMBALA_PAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Response format

Successful tool calls return MCP text content containing a JSON-encoded Tambala Pay API response. Tool-level HTTP errors are returned with `isError: true` and the upstream HTTP status/error in the text content. Invalid JSON-RPC requests use standard JSON-RPC error objects.

## Security and payment rules

- The endpoint is protected by the same server-side `INTERNAL_ACCESS_TOKEN` as the internal REST API.
- Keep the token on trusted organization servers only. Rotate it if it is exposed.
- The dashboard's single-user Supabase login is separate from this machine-to-machine MCP credential.
- Tool calls can create invoices and initiate payment checkouts. Apply the organization's own approval rules before invoking write tools.
- Creating a checkout does not mean money has been received.\n- Monthly contract invoices keep one permanent invoice link and create a separate payment record for each billing month. Only verified `paid` payments mark that month complete; failed or pending attempts do not.
- Only a payment record with server-verified status `paid` confirms collection. Never interpret `pending` as successful.
- Receipt tools return a receipt only after successful payment verification.
- Customer-facing public invoice/checkout routes and the PayChangu webhook are not exposed as MCP tools.

## Related interfaces

- REST API contract: [OpenAPI specification](./openapi.yaml)
- REST API and setup guide: [README](../README.md)
