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
- PDF, PNG, JPG and UTF-8 TXT uploads (3 MB per file, 20 files per order). Files are stored as SQLite blobs outside the public asset directory. Download headers force attachment delivery.
- Audit records for café approval, file uploads, quotes, verified payments and fulfilment.
- Configurable Daraja STK adapter, payment attempt tracking, and versioned digital delivery with customer approval.

## Scope and next milestones

This is an executable foundation, not a payment-ready marketplace. Orders progress through `requested`, `quoted`, `awaiting_payment`, `in_progress`, `awaiting_review`, and `completed`, with a `revision_requested` loop. Only a correlated provider status query can create a verified payment record. No real payment has been exercised in this repository, and physical printing is not connected. Refunds and payouts remain to implement. A CUPS printer bridge and durable queue are included below, pending physical acceptance testing. Café-owned uploads can be submitted as final deliveries only after verified payment; the customer approves the exact pending version or requests a revision.

Next: run the configured Daraja sandbox acceptance flow and the physical CUPS printer acceptance flow. Only paid, approved final files may become print jobs. An uncertain or interrupted printer job must require reconciliation before retrying.

## Deployment boundary

The Vercel entry point is `api/index.js`. Deploy three projects with `SURFACE=customer`, `SURFACE=cafe` and `SURFACE=admin`, sharing one server-only PostgreSQL `DATABASE_URL` and using `SECURE_COOKIES=1`. Vercel refuses an ephemeral SQLite fallback. `vercel.json` routes pages and API requests through the correct surface. Node 24 is required. Uploads are capped at 3 MB to fit Vercel's request limit after base64 encoding.

Wabunifu project `nhvoltweyqvpbhnlyajf` contains the isolated `izicybercafe` schema. `db/schema.sql` and `db/runtime-role.sql` were applied on 28 October 2026; do not reapply them blindly. The dedicated `izicyber_runtime` role has application-table access through RLS policies, no DDL privileges, and starts with NOLOGIN. At provisioning, enable LOGIN with a generated unique password and save the connection URL only in encrypted Vercel environment variables. Use the exact transaction-pooler hostname from Supabase's Connect panel, port 6543 and a project-qualified custom-role username; do not construct a hostname from the region. The driver uses unnamed queries and verifies TLS certificates. Supabase public/anon/authenticated roles cannot access the application schema. Application sessions and tenant authorization remain enforced by the server.

For the admin project's initial operator, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` securely, sign in once, then remove the bootstrap password variable and redeploy. Public registration cannot create admins. M-Pesa remains disabled until a separate sandbox acceptance flow is completed. Deployment is still pending the exact pooler host and end-to-end managed-database validation. Login throttling currently uses per-instance memory and needs shared enforcement before public launch.

For local development, omit `DATABASE_URL` to use SQLite. To run one interface per process, set `SURFACE` and optionally `PORT`; local processes must share the same SQLite file on one host.

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

`npm test` exercises mocked transport and provider responses only; it makes no real charges. It covers payment gating, callback spoofing, amount ownership, duplicate initiation/verification, uncertain responses, failed retries, participant authorization, delivery revisions, stale approvals and persistent ledger records. Browser interaction validation is still outstanding in this development environment.

Before enabling real payments, run a separate sandbox deployment to test STK prompts, successful/cancelled/expired payments, delayed or missing callbacks, query recovery and merchant statement reconciliation. Add scheduled reconciliation, operational recovery, backups, retention controls and merchant payout/refund handling before a production launch.

## Customer receipt animation

Customer payment confirmation includes an original, dependency-free printer-and-paper animation inspired by the supplied [dqnamo receipt-printer experiment](https://www.dqnamo.com/experiments/receipt-printer). The charcoal housing, stepped paper feed, thermal-style typography and perforated paper are implemented locally; no third-party scripts, textures or payment information are sent to the reference site.

Pending, failed and uncertain payments never show paid paper or a download. Once a verified ledger record exists, the paper shows the service, café, ledger amount, stable platform receipt reference, order reference and verification time in Africa/Nairobi. Sandbox receipts are labelled as tests with no real payment. The platform reference is explicitly distinguished from the customer's M-Pesa SMS receipt number, and receipt preparation does not imply order fulfilment or physical document printing.

The first display feeds the paper once per receipt in the page session. Replay only repeats the visual animation; it never initiates or checks a payment. Reopening or refreshing an order retains its verified receipt. Reduced-motion preferences show the paper immediately, and animation listeners are cleaned up when the order closes. Receipt totals remain readable and downloadable without animation support.

**Download receipt** returns an authenticated text attachment at `/api/orders/:id/receipt`. Only the customer who owns the paid order can download it. Pending orders have no receipt, and another customer or café cannot download it. The download uses `Cache-Control: no-store` and the same verified ledger amount/reference as the on-screen receipt. It is a payment record, not a tax invoice.

Validation includes receipt state gating, safe HTML escaping, Nairobi time formatting, ledger-owned totals and download authorization. Local visual preview could not be opened by the cloud browser (`ERR_CONNECTION_REFUSED`), so browser animation and responsive visual QA remain pending.

## Print fulfilment and shop-side agent

Services now declare **Digital delivery**, **Print as uploaded**, or **Edit, approve & print**. Existing services/orders migrate to digital delivery. New orders copy the service's mode; clients cannot override it.

For either print mode, the customer uploads the source document and saves copies (1–100), A4/Letter, monochrome/colour and single-sided/long-edge duplex instructions before the café quotes. Print-only orders require a customer-owned PDF. All pages are printed; page ranges and automatic per-page pricing are not implemented. The café's quote covers the whole document and every requested copy. Settings freeze when that quote is sent, so payment always covers the agreed job.

A verified print-only payment creates one durable queue record in the same transaction as the payment ledger. Editing orders remain in progress until the customer approves the exact final PDF delivery; approval queues that PDF atomically. An unpaid order, unapproved revision or non-PDF final cannot enter the queue. The on-screen receipt animation continues to represent payment only.

### Café printer controls

The café workspace includes printer registration, sandbox/live separation, colour/duplex capabilities, pause/resume, agent-token rotation and the print queue. Agent tokens are shown once and stored only as hashes on the server. Each token belongs to one printer at one café. A compatible printer can claim only its own café's jobs, and sandbox jobs cannot be claimed by a live printer. No printer connected yet simply leaves eligible work queued.

The statuses have distinct meanings:

| Job status | Meaning |
| --- | --- |
| queued | Eligible and waiting for a compatible agent |
| claimed | Issued to one agent; it may already be submitting locally |
| spooled | CUPS accepted the job; physical output is not yet confirmed |
| uncertain | The submission result needs staff investigation |
| ready | Staff confirmed every requested page and copy physically printed |
| collected | Staff recorded customer collection; order is complete |

There are no automatic claim expirations or automatic retries. Interrupted claims remain blocked. Stop the old agent, inspect the physical output and cancel/resolve the old local spool job before explicitly choosing **Resolve & retry**. The API requires an acknowledgement and staff note; retry invalidates the old claim token. Late file requests/reports from that claim are rejected. Already downloaded or submitted work cannot be remotely recalled by pausing or rotating a token; resolve it at the shop computer first. **Confirm ready** requires a separate physical-output acknowledgement.

### Run the agent on a shop computer

The initial adapter targets CUPS on Linux/macOS, using the [official `lp` command](https://www.cups.org/doc/man-lp.html) and [documented printing options](https://www.cups.org/doc/options.html). A native Windows bridge is not included. Confirm the installed printer/driver honours colour, paper and duplex settings before enabling it.

1. Configure and test the local CUPS printer outside the app.
2. Register the printer in the café workspace and save its one-time token securely.
3. Export the variables in `agent/.env.example` on the shop computer. Use the café workspace's HTTPS origin, the local CUPS destination and the matching sandbox/live payment environment. Environment files are not loaded automatically.
4. Keep `PRINT_ENABLE=0` until the shop is ready. Set it to `1` to permit real spool submissions.
5. Run `npm run print-agent -- --once` for one poll, or `npm run print-agent` for polling every five seconds. These commands submit to the actual configured printer when enabled; they are not simulations.
6. Verify the paper at the printer, mark the job ready, and record collection from the café dashboard.

The agent downloads only its currently claimed PDF, checks its SHA-256 digest, writes a private temporary file, and fsyncs a local journal entry before invoking `lp` without a shell. Temporary document files are removed when the attempt returns. A process crash may leave a temporary directory requiring local cleanup. A submission error, unexpected spool response or failed report never triggers another `lp` invocation for that claim. Journals contain job/attempt identifiers rather than document contents or credentials. They are a local duplicate-submission guard, not proof of physical printing.

The first version still needs physical printer acceptance testing, malware-scanning integration, production credential lifecycle work, and browser visual QA. Tests mock spool submission and never print paper. It is not an exactly-once physical printing guarantee: uncertain outcomes require the staff reconciliation described above.
