# iziCyberCafe

A marketplace connecting customers with independent cyber cafés. This initial working slice covers café onboarding, operator approval, service publishing customer requests, private documents, conversations and quotes.

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

Open the URLs above. Register a café on port 3001, sign into admin on port 3002 and approve it. Publish a service from the café workspace. Register a customer on port 3000, find the café and submit a request. Open its order number to upload a document and send a message. In the café workspace, open the same order and send a quote with scope and turnaround. The customer can accept the current quote; the order then waits for payment. The café sees its requests; other cafés and customers cannot see them. Data persists in `data/izi.sqlite`. The application does not automatically load `.env` files. Initial admin provisioning does not change an existing password.

```sh
npm test
npm run check
```

## Current capabilities

- Separate customer, café and operator interfaces with responsive layouts.
- Hashed passwords, eight-hour server sessions, sign-out and basic per-process sign-in throttling.
- Operator-only café approval and suspension with an audit trail.
- Service publishing by approved cafés, location/name search customer requests, private documents, conversations and quotes.
- Server-owned pricing: request prices and café IDs are derived from the service.
- Persistent SQLite records and tenant-filtered order queries.
- Private per-order document downloads, participant-only messaging, and versioned quotes with customer acceptance.
- PDF, PNG, JPG and UTF-8 TXT uploads (5 MB per file, 20 files per order). Files are stored as SQLite blobs outside the public asset directory. Download headers force attachment delivery.
- Approval audit events and quote/file audit events.

## Scope and next milestones

This is an executable foundation, not a payment-ready marketplace. Requests progress through `requested`, `quoted` and `awaiting_payment`; none is treated as paid. The system does not claim to collect payments, print documents, or fulfil work. Revisions, completed-work approval, payment callbacks, refunds, payouts and printer agents remain to implement. Uploaded files are source/reference documents, not verified final deliverables.

Next: verified M-Pesa callbacks with an idempotent payment ledger; then a durable print queue and shop-side agent. Only paid, approved final files may become print jobs. An uncertain or interrupted printer job must require reconciliation before retrying.

## Deployment boundary

No public deployment or domain configuration is included. To run one interface per process, set `SURFACE=customer`, `SURFACE=cafe` or `SURFACE=admin` and optionally `PORT`. The processes must share the same SQLite file on one host; do not copy it across independent containers. For multi-host production, move the data layer to a managed database and coordinate transactions, sessions and throttling centrally.

Use distinct HTTPS hostnames with a trusted reverse proxy, enable `SECURE_COOKIES=1`, and keep the app bound to loopback behind that proxy. The proxy must preserve the external Host and strip untrusted forwarded headers. Configure backups, credential recovery, central rate limiting and monitoring before a production launch. Separate URLs do not replace authorization. No real documents, customer data or credentials belong in this public repository.

## Document and quote boundaries

Only the customer who created an order and its assigned café owner can enter its document/conversation workspace. Platform admin oversight does not automatically grant document access. Suspended cafés cannot download documents; order mutations are paused for both participants during suspension. Existing customers retain downloads.

A new quote supersedes the previous pending quote. Acceptance requires the exact current quote ID, uses its server-stored amount, and runs in a transaction. Accepted quotes cannot be changed. Acceptance does not mark an order paid or start a print job.

Uploads are validated by extension and basic file signatures/UTF-8 encoding, not malware-scanned or parsed for document validity. No inline previews or external submissions are enabled. Introduce malware scanning, retention/deletion controls, encrypted storage policy and storage quotas per business before using real customer documents in production. Messages are limited to 500 per order.
