# iziCyberCafe

A marketplace connecting customers with independent cyber cafés. This initial working slice covers café onboarding, operator approval, service publishing and customer requests.

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

Open the URLs above. Register a café on port 3001, sign into admin on port 3002 and approve it. Publish a service from the café workspace. Register a customer on port 3000, find the café and submit a request. The café sees its requests; other cafés and customers cannot see them. Data persists in `data/izi.sqlite`. The application does not automatically load `.env` files. Initial admin provisioning does not change an existing password.

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

## Scope and next milestones

This is an executable foundation, not a payment-ready marketplace. Requests stay unpaid at `requested`. The system does not claim to collect payments, print documents, or fulfil work. File uploads, quotes, messaging, revisions, payment callbacks, refunds, payouts and printer agents remain to implement.

Next: private file storage with per-order access; quotes and revisions; verified M-Pesa callbacks with an idempotent payment ledger; then a durable print queue and shop-side agent. Only paid, approved final files may become print jobs. An uncertain or interrupted printer job must require reconciliation before retrying.

## Deployment boundary

No public deployment or domain configuration is included. To run one interface per process, set `SURFACE=customer`, `SURFACE=cafe` or `SURFACE=admin` and optionally `PORT`. The processes must share the same SQLite file on one host; do not copy it across independent containers. For multi-host production, move the data layer to a managed database and coordinate transactions, sessions and throttling centrally.

Use distinct HTTPS hostnames with a trusted reverse proxy, enable `SECURE_COOKIES=1`, and keep the app bound to loopback behind that proxy. The proxy must preserve the external Host and strip untrusted forwarded headers. Configure backups, credential recovery, central rate limiting and monitoring before a production launch. Separate URLs do not replace authorization. No real documents, customer data or credentials belong in this public repository.
