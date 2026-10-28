# iziCyberCafe

A marketplace connecting customers with independent cyber cafés. This application covers café onboarding, operator approval, service publishing, customer requests, private documents, conversations, quotes, payment verification and delivery approval.

## Three independent interfaces

| Interface | Local URL | Intended production host (examples only) |
| --- | --- | --- |
| Customer | http://localhost:3000 | app.your-domain |
| Café workspace | http://localhost:3001 | business.your-domain |
| Platform administration | http://localhost:3002 | control.your-domain |

The admin system has a dedicated server listener, sign-in experience, session cookie and API surface. It is not a role switch inside the customer application. There is no public admin registration. All role checks and café ownership checks happen on the server. Cookie Domain is omitted so deployed hostnames receive host-only cookies. Ports alone do not isolate cookies in browsers; different cookie names provide local session separation.

## Run

Requires Node.js 22.13+ with built-in SQLite (tested on Node 24). No external packages required.

```sh
export ADMIN_EMAIL='operator@example.com'
export ADMIN_PASSWORD='use-a-unique-long-password-here'
npm start
```

Open the URLs above. Register a café on port 3001, sign into admin on port 3002 and approve it. Publish a service from the café workspace. Register a customer on port 3000, find the café and submit a request. Open its order number to upload a document and send a message. In the café workspace, open the same order and send a quote with scope and turnaround. The customer can accept the current quote; the order then waits for payment. Configure M-Pesa to test payment verification and unlock delivery/review. Without configuration, payment requests fail closed. The café sees its requests; other cafés and customers cannot see them. Data persists in `data/izi.sqlite`. The application does not automatically load `.env` files. Initial admin provisioning does not change an existing password.

```sh
npm test
npm run check
```

## Current capabilities

- Separate customer, café and operator interfaces with responsive layouts.
- Hashed passwords, eight-hour server sessions, sign-out and basic per-process sign-in throttling.
- Operator-only café approval and suspension with an audit trail.
- Service publishing by approved cafés, location/name search and customer requests.
- Server-owned pricing: request prices and café IDs are derived from the service.
- Persistent SQLite records and tenant-filtered order queries.
- Private per-order document downloads, participant-only messaging, and versioned quotes with customer acceptance.
- PDF, PNG, JPG and UTF-8 TXT uploads (5 MB per file, 20 files per order). Files are stored as SQLite blobs outside the public asset directory. Download headers force attachment delivery.
- Audit records for café approval, file uploads, quotes, verified payments and fulfilment.
- Configurable Daraja STK adapter, payment attempt tracking, and versioned digital delivery with customer approval.

## Scope and next milestones

This is an executable foundation, not a payment-ready marketplace. Orders progress through `requested`, `quoted`, `awaiting_payment`, `in_progress`, `awaiting_review`, and `completed`, with a `revision_requested` loop. Only a correlated provider status query can create a verified payment record. No real payment has been exercised in this repository, and physical printing is not connected. Refunds, payouts and printer agents remain to implement. Café-owned uploads can be submitted as final deliveries only after verified payment; the customer approves the exact pending version or requests a revision.

Next: run the configured Daraja sandbox acceptance flow, then add a durable print queue and shop-side agent. Only paid, approved final files may become print jobs. An uncertain or interrupted printer job must require reconciliation before retrying.

## Deployment boundary

No public deployment or domain configuration is included. To run one interface per process, set `SURFACE=customer`, `SURFACE=cafe` or `SURFACE=admin` and optionally `PORT`. The processes must share the same SQLite file on one host; do not copy it across independent containers. For multi-host production, move the data layer to a managed database and coordinate transactions, sessions and throttling centrally.

Use distinct HTTPS hostnames with a trusted reverse proxy, enable `SECURE_COOKIES=1`, and keep the app bound to loopback behind that proxy. The proxy must preserve the external Host and strip untrusted forwarded headers. Configure backups, credential recovery, central rate limiting and monitoring before a production launch. Separate URLs do not replace authorization. No real documents, customer data or credentials belong in this public repository.

## Document and quote boundaries

Only the customer who created an order and its assigned café owner can enter its document/conversation workspace. Platform admin oversight does not automatically grant document access. Suspended cafés cannot download documents; order mutations are paused for both participants during suspension. Existing customers retain downloads.

A new quote supersedes the previous pending quote. Acceptance requires the exact current quote ID, uses its server-stored amount, and runs in a transaction. Accepted quotes cannot be changed. Acceptance does not mark an order paid or start a print job. Verified payment is a separate server-owned transition.

Uploads are validated by extension and basic file signatures/UTF-8 encoding, not malware-scanned or parsed for document validity. No inline previews or external submissions are enabled. Introduce malware scanning, retention/deletion controls, encrypted storage policy and storage quotas per business before using real customer documents in production. Messages are limited to 500 per order.

## M-Pesa integration and fulfilment

The Daraja adapter follows Safaricom's [M-Pesa Express documentation](https://developer.safaricom.co.ke/apis/MpesaExpressSimulate) and [official STK Query SDK](https://github.com/safaricom/mpesa-php-sdk/blob/master/src/Mpesa.php). Set the environment variables documented in `.env.example`; payment support is disabled unless `MPESA_ENABLED=1`. No live credentials or public deployment are included. Use `SECURE_COOKIES=1` behind HTTPS and set `MPESA_CALLBACK_BASE` to the customer app's HTTPS origin. The provider callback is exposed only on the customer listener. Never ask customers to enter an M-Pesa PIN in the website.

The configured shortcode receives all payments. This is a platform-collection implementation, not split settlement or direct payment to individual cafés. Business onboarding, merchant arrangement, commissions, refunds and payouts must be settled before live launch. Sandbox and live attempts may not share a database; startup rejects mixing environments. Use a clean database when moving to live.

Payment attempts are recorded durably before STK initiation. The server locks the accepted quote amount and allows at most one initiating, pending, uncertain or paid attempt per order. An HTTP timeout or unconfirmed initiation enters `review` and blocks retry until merchant reconciliation; do not delete this record or retry blindly. The admin dashboard lists recent attempts with masked phone numbers and provider references. A query-confirmed terminal failure permits another attempt.

Callbacks are hints, not proof of payment. The callback path correlates a server-generated attempt ID and checks both provider identifiers; the server then makes an authenticated status query. Only a response matching the stored checkout and merchant identifiers can mark payment verified. Callback-supplied result codes, amounts and receipt numbers never create a payment. The ledger stores a checkout reference, not a purported M-Pesa receipt. A missing receipt still needs statement reconciliation before financial reporting or payout.

Query checks are spaced 10 seconds apart and may be triggered by a callback or the customer's **Check payment status** button. Lost callbacks can be recovered by checking a known checkout. There is no scheduled reconciliation worker yet. If initiation succeeds remotely but the response is lost locally, an operator must investigate the merchant account; the app cannot safely retry or resolve that ambiguity on its own. Provider outages leave payment unverified.

After verification, the assigned café can submit one of its own order files with a delivery note. The customer downloads it, approves that exact pending delivery, or requests a revision. A revision needs a new upload and creates a new version. Duplicate/stale approval and changes to an accepted quote are rejected. Suspension pauses fulfilment mutations. Approval completes digital work; it does not assert that paper has printed or been collected.

### Validation

`npm test` exercises mocked transport and provider responses only; it makes no real charges. It covers payment gating, callback spoofing, amount ownership, duplicate initiation/verification, uncertain responses, failed retries, participant authorization, delivery revisions, stale approvals and persistent ledger records. Browser interaction validation is still outstanding because a Chromium download was unavailable in the development environment.

Before enabling real payments, run a separate sandbox deployment to test STK prompts, successful/cancelled/expired payments, delayed or missing callbacks, query recovery and merchant statement reconciliation. Add scheduled reconciliation, operational recovery, backups, retention controls and merchant payout/refund handling before a production launch.
