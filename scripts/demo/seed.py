#!/usr/bin/env python3
"""
Seed a fake but realistic Happy setup for README screenshots, all under ~/HappyDemo:
  ledgerly/       a demo repo (git history, worktrees in every stage, deploy tags, .happy/config.json)
  ledgerly.git    its "origin"
  data/           Happy's data folder for the demo (sessions, settings) — separate from your real one
  demo.json       what Happy shows instead of your accounts (Cloud, errors, limits, next steps…)
Run:  python3 scripts/demo/seed.py && SESSION_HUB_DEMO=~/HappyDemo/demo.json npx electron .
Nothing here comes from real data: every name, email, number and log line is made up.
"""
import json, os, random, shutil, subprocess, time, uuid
from pathlib import Path

random.seed(7)
HOME = Path.home()
ROOT = HOME / "HappyDemo"
REPO = ROOT / "ledgerly"
ORIGIN = ROOT / "ledgerly.git"
DATA = ROOT / "data"
NOW = time.time()
MS = lambda t: int(t * 1000)
H, D = 3600, 86400

if ROOT.exists():
    shutil.rmtree(ROOT)
ROOT.mkdir()

ENV = {**os.environ, "GIT_AUTHOR_NAME": "Maya Chen", "GIT_AUTHOR_EMAIL": "maya@ledgerly.dev", "GIT_COMMITTER_NAME": "Maya Chen", "GIT_COMMITTER_EMAIL": "maya@ledgerly.dev"}

def git(*a, cwd=REPO, when=None):
    e = dict(ENV)
    if when:
        d = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(when))
        e["GIT_AUTHOR_DATE"] = e["GIT_COMMITTER_DATE"] = d
    return subprocess.run(["git", *a], cwd=cwd, env=e, check=True, capture_output=True, text=True).stdout.strip()

def write(rel, text, root=REPO):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)

def commit(msg, when, root=REPO):
    git("add", "-A", cwd=root)
    git("commit", "-q", "-m", msg, cwd=root, when=when)
    return git("rev-parse", "HEAD", cwd=root)

# ── the repo ────────────────────────────────────────────────────
REPO.mkdir()
git("init", "-q", "-b", "main")
write("README.md", "# Ledgerly\n\nInvoicing and payments for small businesses.\n")
write("api/app/main.py", "from fastapi import FastAPI\n\nfrom app.billing import router as billing\n\napp = FastAPI(title=\"Ledgerly API\")\napp.include_router(billing)\n")
write("api/app/billing/notifications.py", '''"""Invoice emails: sent when an invoice is issued, paid, or past due."""
from app.email import send_template
from app.models import Invoice


def notify_issued(invoice: Invoice) -> None:
    send_template("invoice_issued", to=invoice.customer.billing_email, invoice=invoice)


def notify_paid(invoice: Invoice) -> None:
    send_template("invoice_paid", to=invoice.customer.billing_email, invoice=invoice)
''')
write("api/app/billing/retry.py", '''"""Retries for failed card payments (Stripe webhooks call into this)."""
from app.billing.notifications import notify_issued
from app.models import Invoice


def retry_payment(invoice: Invoice) -> bool:
    ok = invoice.charge()
    notify_issued(invoice)
    return ok
''')
write("api/app/billing/__init__.py", "from fastapi import APIRouter\n\nrouter = APIRouter(prefix=\"/billing\")\n")
write("api/tests/test_retry.py", "def test_retry_charges_once():\n    ...\n")
write("web/app/invoices/page.tsx", "export default function Invoices() {\n  return <InvoiceTable />;\n}\n")
write("web/app/checkout/page.tsx", "export default function Checkout() {\n  return <CheckoutForm />;\n}\n")
write("db/migrations/0041_invoice_number_index.sql", "CREATE INDEX CONCURRENTLY idx_invoices_number ON invoices (number);\n")
write("sdk/package.json", json.dumps({"name": "@ledgerly/sdk", "version": "1.8.0", "main": "dist/index.js"}, indent=2) + "\n")
write("sdk/src/index.ts", "export { Ledgerly } from './client';\n")
write(".happy/config.json", json.dumps({
    "description": "Ledgerly: invoicing and payments (FastAPI api, Next.js web, Postgres) on Cloud Run",
    "environments": [
        {"id": "prod", "name": "Production", "color": "#3b82f6", "tag": ""},
        {"id": "eu", "name": "Europe", "color": "#a855f7", "tag": "eu"},
        {"id": "staging", "name": "Staging", "color": "#14b8a6", "tag": "staging"},
    ],
    "deploy": {
        "components": [
            {"id": "api", "short": "api", "label": "API", "paths": ["api/"]},
            {"id": "web", "short": "web", "label": "Web app", "paths": ["web/"]},
            {"id": "db", "short": "db", "label": "Migrations", "paths": ["db/migrations/"]},
        ],
        "commands": {"api": "./deploy.sh {env} api", "web": "./deploy.sh {env} web", "db": "./deploy.sh {env} db", "core": "./deploy.sh {env} db api web", "full": "./deploy.sh {env} all"},
    },
    "packages": [{"dir": "sdk"}],
    "glossary": {"eu": "Europe"},
}, indent=2) + "\n")
base = commit("Initial Ledgerly monorepo", NOW - 20 * D)

history = [
    ("api/app/billing/invoices.py", "def list_invoices(org_id):\n    ...\n", "List invoices by organization", 18),
    ("web/components/InvoiceTable.tsx", "export function InvoiceTable() { return null; }\n", "Invoice table with status filters", 16),
    ("api/app/webhooks/stripe.py", "def handle(event):\n    ...\n", "Stripe webhook handler", 14),
    ("db/migrations/0042_payment_attempts.sql", "CREATE TABLE payment_attempts (id uuid primary key, invoice_id uuid, created_at timestamptz);\n", "Track payment attempts", 12),
    ("web/app/settings/billing/page.tsx", "export default function Billing() { return null; }\n", "Billing settings page", 10),
    ("api/app/billing/tax.py", "def tax_for(invoice):\n    ...\n", "Sales tax for US invoices", 8),
]
for rel, text, msg, days in history:
    write(rel, text)
    commit(msg, NOW - days * D)

ORIGIN.mkdir()
git("init", "-q", "--bare", cwd=ORIGIN)
git("remote", "add", "origin", str(ORIGIN))
git("push", "-q", "-u", "origin", "main")

def tag(env, comp, when):
    sha = git("rev-parse", "HEAD")
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(when))
    name = f"deployed-{env + '-' if env else ''}{comp}-{stamp}-{sha[:10]}"
    git("tag", name)

# Everything deployed a week ago (full), staging more recently.
tag("", "full", NOW - 7 * D)
tag("eu", "full", NOW - 7 * D)
tag("staging", "full", NOW - 6 * D)

def worktree(branch, when):
    path = ROOT / f"ledgerly-{branch}"
    git("worktree", "add", "-q", "-b", branch, str(path), "main")
    return path, git("rev-parse", "HEAD", cwd=path)

wts = {}
# Merged + deployed everywhere: webhook secret rotation.
p, b = worktree("webhook-secret-rotation", NOW - 6 * D)
write("api/app/webhooks/secrets.py", "def current_secrets():\n    return [primary(), previous()]\n", p)
commit("Accept both webhook secrets during rotation", NOW - 5 * D, p)
git("merge", "-q", "--no-ff", "webhook-secret-rotation", "-m", "Merge webhook-secret-rotation", when=NOW - 5 * D)
wts["webhook-secret-rotation"] = (p, b)
tag("", "api", NOW - 4 * D); tag("eu", "api", NOW - 4 * D); tag("staging", "api", NOW - 4 * D)

# Merged, SDK bumped, not on npm (publish needed).
p, b = worktree("sdk-pagination-helpers", NOW - 4 * D)
write("sdk/src/paginate.ts", "export async function* paginate(list) { /* … */ }\n", p)
write("sdk/package.json", json.dumps({"name": "@ledgerly/sdk", "version": "1.9.0", "main": "dist/index.js"}, indent=2) + "\n", p)
commit("SDK: typed pagination helpers (1.9.0)", NOW - 3 * D, p)
git("merge", "-q", "--no-ff", "sdk-pagination-helpers", "-m", "Merge sdk-pagination-helpers", when=NOW - 3 * D)
wts["sdk-pagination-helpers"] = (p, b)

# Merged, with a backfill script and a migration: deploy pending.
p, b = worktree("dunning-backfill", NOW - 3 * D)
write("api/scripts/backfill_dunning_schedule.py", "\"\"\"Give past-due accounts a dunning schedule (one-off).\"\"\"\n", p)
write("db/migrations/0043_dunning_schedule.sql", "ALTER TABLE invoices ADD COLUMN dunning_step smallint;\n", p)
write("api/app/billing/dunning.py", "STEPS = [3, 7, 14]  # days after due\n", p)
commit("Dunning schedule for past-due invoices", NOW - 2 * D, p)
git("merge", "-q", "--no-ff", "dunning-backfill", "-m", "Merge dunning-backfill", when=NOW - 1.5 * D)
wts["dunning-backfill"] = (p, b)
tag("staging", "full", NOW - 1.2 * D)

# Landed on main today (for the board's "landed" list).
write("web/components/EmptyState.tsx", "export function EmptyState() { return null; }\n")
commit("Friendlier empty state on the invoices page", NOW - 5 * H)
git("push", "-q", "origin", "main", "--tags")

# Committed, not merged: faster invoice list.
p, b = worktree("faster-invoice-list", NOW - 1 * D)
write("api/app/billing/invoices.py", "def list_invoices(org_id, cursor=None, limit=50):\n    # keyset pagination on (issued_at, id)\n    ...\n", p)
commit("Keyset pagination for the invoice list", NOW - 20 * H, p)
write("db/migrations/0044_invoices_issued_at_idx.sql", "CREATE INDEX CONCURRENTLY idx_invoices_org_issued ON invoices (org_id, issued_at DESC, id);\n", p)
commit("Index for the invoice list", NOW - 19 * H, p)
wts["faster-invoice-list"] = (p, b)

# Uncommitted: EU VAT reverse charge (with a new migration).
p, b = worktree("eu-vat-reverse-charge", NOW - 3 * H)
write("api/app/billing/tax.py", "def tax_for(invoice):\n    if invoice.customer.vat_id and invoice.customer.country in EU and invoice.seller_country != invoice.customer.country:\n        return reverse_charge(invoice)\n    ...\n", p)
write("db/migrations/0045_customer_vat_id.sql", "ALTER TABLE customers ADD COLUMN vat_id text;\n", p)
wts["eu-vat-reverse-charge"] = (p, b)

# Uncommitted: the main screenshot's fix.
p, b = worktree("fix-duplicate-invoice-emails", NOW - 2 * H)
write("api/app/billing/retry.py", '''"""Retries for failed card payments (Stripe webhooks call into this)."""
from app.billing.notifications import notify_paid
from app.models import Invoice


def retry_payment(invoice: Invoice) -> bool:
    ok = invoice.charge()
    # Only email on a successful retry; the original "issued" email already went out.
    if ok and not invoice.paid_email_sent_at:
        notify_paid(invoice)
        invoice.mark_paid_email_sent()
    return ok
''', p)
write("api/tests/test_retry.py", '''from app.billing.retry import retry_payment


def test_retry_charges_once(invoice_factory, outbox):
    inv = invoice_factory(status="past_due")
    retry_payment(inv)
    retry_payment(inv)
    assert len(outbox.sent("invoice_paid")) == 1


def test_failed_retry_sends_nothing(invoice_factory, outbox, failing_card):
    inv = invoice_factory(status="past_due", card=failing_card)
    retry_payment(inv)
    assert outbox.sent() == []
''', p)
write("db/migrations/0046_invoice_paid_email_sent_at.sql", "ALTER TABLE invoices ADD COLUMN paid_email_sent_at timestamptz;\n", p)
wts["fix-duplicate-invoice-emails"] = (p, b)

# Uncommitted: flaky e2e.
p, b = worktree("flaky-checkout-e2e", NOW - 26 * H)
write("web/e2e/checkout.spec.ts", "test('checkout', async ({ page }) => {\n  await page.getByRole('button', { name: 'Pay' }).click();\n  await expect(page.getByText('Paid')).toBeVisible();\n});\n", p)
wts["flaky-checkout-e2e"] = (p, b)

# ── sessions ────────────────────────────────────────────────────
def item(kind, text, t, **kw):
    return {"id": str(uuid.uuid4()), "ts": MS(t), "kind": kind, "text": text, **kw}

def tool(name, text, t, detail="", dur=900, result=None):
    return item("tool", text, t, tool=name, detail=detail, status="done", durationMs=dur, **({"result": result} if result else {}))

def session(title, engine, branch=None, model=None, ago=1 * H, items=(), tags=None, group=None, cost=0.0, tokens=0, active=0, extra=None):
    sid = str(uuid.uuid4())
    path, b = wts[branch] if branch else (REPO, None)
    meta = {
        "id": sid, "engine": engine, "title": title, "titleSource": "agent", "cwd": str(path), "model": model,
        "permissionMode": "bypassPermissions" if engine == "claude" else None,
        "engineSessionId": str(uuid.uuid4()), "createdAt": MS(NOW - ago - 2 * H), "updatedAt": MS(NOW - ago), "linksCleaned": True,
    }
    if branch:
        meta["worktree"] = {"path": str(path), "branch": branch, "repo": str(REPO), "baseSha": b}
    if tags:
        meta["tags"] = tags
    if group:
        meta["groupId"] = group
    meta.update(extra or {})
    return {"meta": {k: v for k, v in meta.items() if v is not None}, "items": list(items), "costUsd": cost, "tokens": tokens, "activeMs": active, "engineState": {}}

g_billing, g_platform, g_ideas = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
groups = [{"id": g_billing, "name": "Billing"}, {"id": g_platform, "name": "Platform"}, {"id": g_ideas, "name": "Ideas", "collapsed": False}]

t0 = NOW - 70 * 60
main_items = [
    item("user", "Customers on retried card payments are getting the invoice email twice. Find out why and fix it, with a test.", t0),
    tool("Grep", "notify_issued|notify_paid", t0 + 20, "api/app/billing/retry.py:8\napi/app/billing/notifications.py:6\napi/app/webhooks/stripe.py:31", 310),
    tool("Read", "api/app/billing/retry.py", t0 + 35, dur=120),
    tool("Read", "api/app/webhooks/stripe.py", t0 + 48, dur=140),
    tool("Bash", "cd api && pytest tests/test_retry.py -q", t0 + 90, "1 failed, 0 passed\nAssertionError: expected 1 'invoice_paid' email, got 2", 6400, "exit 1"),
    item("assistant", "Found it. `retry_payment` re-sends the \"invoice issued\" email on every retry, and Stripe retries a failed charge up to three times, so one customer can get it three or four times.\n\nI added a test that reproduces it: two retries, two emails.", t0 + 100),
    item("user", "Is it only retries? Check the webhook path too.", t0 + 9 * 60),
    tool("Read", "api/app/webhooks/stripe.py", t0 + 9 * 60 + 15, dur=110),
    tool("Grep", "event.id|idempotency", t0 + 9 * 60 + 30, "api/app/webhooks/stripe.py:12: if seen(event.id): return", 280),
    item("assistant", "Only retries. The webhook handler already skips events it has seen (it checks `event.id` before doing anything), so a webhook delivered twice can't send a second email on its own. The duplicate comes from the retry path calling the email directly.", t0 + 9 * 60 + 50),
    item("user", "ok fix it. a successful retry should still send the paid email, just once.", t0 + 14 * 60),
    tool("Edit", "api/app/billing/retry.py", t0 + 14 * 60 + 30, dur=200),
    tool("Edit", "api/tests/test_retry.py", t0 + 14 * 60 + 50, dur=180),
    tool("Write", "db/migrations/0046_invoice_paid_email_sent_at.sql", t0 + 15 * 60, dur=90),
    tool("Bash", "cd api && pytest tests/test_retry.py -q", t0 + 15 * 60 + 40, "2 passed in 0.41s", 5900, "exit 0"),
    item("assistant", '''Fixed. A retry now only emails when the charge **succeeds**, and only once.

- The "invoice issued" email is no longer re-sent on retries.
- A successful retry sends "invoice paid" once, even if Stripe delivers the webhook twice.
- A failed retry sends nothing.

It records the send in a new column, `invoices.paid_email_sent_at` (migration 0046). Both tests pass. Nothing is committed yet.''', t0 + 16 * 60, pinned=True),
    item("tags", "added #migration", t0 + 16 * 60 + 15, tagsAdded=["migration"], tagsRemoved=[]),
    item("user", "what's left before this can ship?", t0 + 34 * 60),
    item("assistant", '''Three things, in this order:

1. **Run migration 0046** on staging, then prod and EU. The new code reads the column, so it has to exist first.
2. **Mark invoices that were already paid**, so the first retry after the deploy doesn't email them again. It's a one-line backfill: set `paid_email_sent_at` to `paid_at` where it's empty.
3. **Commit and open a PR.** CI runs the billing suite.

The email template doesn't change, so support doesn't need to know.''', t0 + 35 * 60, pinned=True),
]

sessions = [
    session("Fix duplicate invoice emails on retry", "claude", "fix-duplicate-invoice-emails", "claude-opus-5-5", 3 * 60, main_items, tags=["migration"], group=g_billing, cost=4.27, tokens=1_046_000, active=MS(19 * 60 + 40)),
    session("Add EU VAT reverse charge to checkout", "codex", "eu-vat-reverse-charge", "gpt-5.6", 60, [
        item("user", "EU B2B customers with a valid VAT ID should get reverse charge instead of VAT. Add the VAT ID field and the tax rule.", NOW - 50 * 60),
        item("assistant", "Adding `vat_id` to customers (migration 0045) and a reverse-charge branch in `tax_for`. Validating IDs against VIES next.", NOW - 2 * 60),
    ], tags=["migration"], group=g_billing, cost=0.62, tokens=190000),
    session("Dunning schedule backfill for past-due accounts", "claude", "dunning-backfill", "claude-sonnet-5-5", 26 * H, [
        item("user", "Give every past-due account a dunning schedule, and backfill the existing ones.", NOW - 30 * H),
        item("assistant", "Merged. The new column ships in migration 0043, and `api/scripts/backfill_dunning_schedule.py` fills it for the 1,284 accounts already past due. It's live on staging; prod and EU still need the deploy, then the backfill run.", NOW - 26 * H),
    ], tags=["backfill", "migration"], group=g_billing, cost=0.91, tokens=260000),
    session("Speed up the invoice list", "cursor", "faster-invoice-list", "composer-2", 19 * H, [
        item("user", "The invoices page takes 3–4s for big orgs. Make it fast.", NOW - 22 * H),
        item("assistant", "Switched to keyset pagination on (issued_at, id) and added a covering index. p95 goes from 3.4s to 180ms on the staging copy. Two commits, not merged yet.", NOW - 19 * H),
    ], tags=["migration"], group=g_billing),
    session("Rotate Stripe webhook secrets", "claude", "webhook-secret-rotation", "claude-opus-5-5", 4 * D, [
        item("user", "We need to rotate the Stripe webhook secret without dropping events.", NOW - 5 * D),
        item("assistant", "Done and deployed everywhere: the handler accepts both the old and new secret for 24 hours, then only the new one.", NOW - 4 * D),
    ], tags=["qa"], group=g_platform),
    session("SDK: typed pagination helpers", "codex", "sdk-pagination-helpers", "gpt-5.6", 3 * D, [
        item("user", "Add a paginate() helper to the SDK so people stop writing cursor loops.", NOW - 3.2 * D),
        item("assistant", "Merged as 1.9.0. It still needs publishing to npm.", NOW - 3 * D),
    ], tags=["npm"], group=g_platform),
    session("Flaky checkout end-to-end test", "cursor", "flaky-checkout-e2e", "composer-2", 26 * H, [
        item("user", "checkout.spec.ts fails about 1 in 10 runs on CI.", NOW - 27 * H),
        item("assistant", "It clicks Pay before Stripe's iframe is ready. Waiting for the frame to load fixes it locally (200 runs, 0 failures).", NOW - 26 * H),
    ], group=g_platform),
    session("Onboarding email copy refresh", "claude", None, "claude-sonnet-5-5", 2 * D, [
        item("user", "Rewrite the welcome email series. Shorter, friendlier.", NOW - 2.1 * D),
        item("assistant", "Drafted all four emails in docs/onboarding-emails.md for review.", NOW - 2 * D),
    ]),
    session("Usage-based pricing: what would it take?", "claude", None, "claude-opus-5-5", 5 * D, [
        item("user", "If we added usage-based pricing, what changes in billing?", NOW - 5.1 * D),
        item("assistant", "Three pieces: metering events, a rating job that turns usage into invoice lines, and proration on plan changes.", NOW - 5 * D),
    ], group=g_ideas),
]

manager = session("Manager", "claude", None, "claude-opus-5-5", 20 * 60, [
    item("user", "what needs me today?", NOW - 22 * 60),
    item("assistant", '''Three things:

1. **M1** · *Speed up the invoice list* is committed but not merged. It's ready for review.
2. **D2** · the dunning backfill is merged but only live on staging. Prod and EU need the deploy, then the backfill.
3. **E1** · `PaymentIntent retrieve timed out` spiked on EU in the last hour (61 errors). It's Stripe-side latency; the Cloud chat has details.

The SDK (1.9.0) also still needs publishing.''', NOW - 20 * 60),
], extra={"isManager": True, "titleSource": "user", "cwd": str(REPO)}, cost=0.74, tokens=186_000, active=MS(2 * 60 + 40))
manager["meta"].pop("worktree", None)

cloud_chat = session("Cloud", "claude", None, "claude-opus-5-5", 9 * 60, [
    item("user", "why are 5xx up on the EU api?", NOW - 11 * 60),
    tool("Bash", "gcloud logging read 'resource.labels.service_name=\"api\" severity>=ERROR' --project ledgerly-eu --freshness 1h", NOW - 10.7 * 60, "61 entries · 58 × stripe.error.APIConnectionError: PaymentIntent retrieve timed out", 4200),
    item("assistant", '''It's Stripe, not us. 58 of the 61 errors in the last hour are `PaymentIntent retrieve timed out` from the payment status poller, all between 14:05 and 14:40, and Stripe's status page shows degraded API latency in eu-west for the same window.

- No deploy went out in that time (the last EU deploy was 4 days ago).
- Retries recovered every payment; none are stuck.

Nothing to fix. If it keeps happening, the poller's 5s timeout could go to 15s.''', NOW - 9 * 60),
], extra={"isCloud": True, "titleSource": "user", "cwd": str(REPO)}, cost=0.52, tokens=131_000, active=MS(1 * 60 + 52))

day = time.strftime("%Y-%m-%d", time.localtime(NOW))
state = {
    "sessions": [manager, cloud_chat, *sessions],
    "groups": groups,
    "usage": {day: {"tokens": 3_412_000, "costUsd": 18.62}, f"{day}|claude": {"tokens": 2_380_000, "costUsd": 0}, f"{day}|codex": {"tokens": 840_000, "costUsd": 0}, f"{day}|cursor": {"tokens": 192_000, "costUsd": 0}},
    "limits": {},
}
DATA.mkdir()
(DATA / "hub-state.json").write_text(json.dumps(state))
(DATA / "settings.json").write_text(json.dumps({
    "repo": str(REPO), "defaultEngine": "claude", "nextSteps": True, "autoTags": True,
    "profile": {"name": "Maya", "email": "maya@ledgerly.dev", "company": "engineering lead at Ledgerly", "signoff": "Maya", "style": ""},
    "show": {"manager": True, "cloud": True, "tasks": True, "email": True, "calendar": True, "terminal": True},
    "tags": [
        {"name": "backfill", "description": "The changes include a backfill script that still has to be run.", "auto": True},
        {"name": "migration", "description": "The changes include a database migration that hasn't been applied yet.", "auto": True},
        {"name": "npm", "description": "A package changed and its new version still needs publishing to npm.", "auto": True},
        {"name": "qa", "description": "A person needs to review or test this by hand.", "auto": False},
    ],
}))

# ── what Happy shows instead of your accounts ───────────────────
def curve(base, spike_at=None, spike=0, n=24, noise=0.25):
    out = []
    for i in range(n):
        v = base * (0.6 + 0.4 * abs(((i + 8) % 24) - 12) / 12) * (1 + random.uniform(-noise, noise))
        if spike_at is not None and i >= spike_at:
            v += spike * (1 - (i - spike_at) / 6)
        out.append(max(0, round(v)))
    return out

def service(name, req, e5, p95, rev, deployed_days, tenant):
    return {"name": name, "region": "europe-west1" if tenant == "eu" else "us-central1", "ready": True, "revision": rev, "deployedAt": MS(NOW - deployed_days * D),
            "deployedBy": "deploy@ledgerly-ci.iam", "requests": req, "err5xx": e5, "err4xx": round(req * 0.004), "p95": p95, "instances": 3,
            "hourly": curve(req / 24), "hourly5xx": curve(e5 / 24, 21 if e5 > 40 else None, e5 / 4), "link": "https://console.cloud.google.com/run"}

def tenant(tid, project, mult, e5, issues, errors):
    t = {
        "tenant": tid, "project": project, "region": "europe-west1" if tid == "eu" else "us-central1", "fetchedAt": MS(NOW - 90), "failures": {},
        "services": [service("api", round(412_000 * mult), e5, 184, "api-00412-qid", 4, tid), service("web", round(268_000 * mult), 3, 96, "web-00288-mrv", 7, tid), service("worker", round(51_000 * mult), 0, 310, "worker-00157-zsk", 7, tid)],
        "jobs": [{"name": "nightly-dunning", "status": "succeeded", "lastRun": MS(NOW - 9 * H), "durationS": 148, "link": "#"}, {"name": "revenue-rollup", "status": "succeeded", "lastRun": MS(NOW - 3 * H), "durationS": 62, "link": "#"}],
        "schedules": [{"name": "dunning-daily", "schedule": "0 6 * * *", "timeZone": "UTC", "paused": False, "lastAttempt": MS(NOW - 9 * H), "failed": False}, {"name": "rollup-hourly", "schedule": "0 * * * *", "paused": False, "lastAttempt": MS(NOW - 20 * 60), "failed": False}],
        "queues": [{"name": "emails", "running": True, "depth": round(14 * mult), "hourly": curve(40 * mult), "link": "#"}, {"name": "webhooks", "running": True, "depth": 2, "hourly": curve(25 * mult), "link": "#"}],
        "sql": [{"name": "ledgerly-db", "state": "RUNNABLE", "version": "POSTGRES_16", "tier": "db-custom-4-16384", "cpu": 0.31 * mult + 0.1, "mem": 0.58, "disk": 0.44, "connections": round(62 * mult),
                 "cpuHourly": [round(v / 100, 2) for v in curve(30 * mult)], "link": "#",
                 "slow": {"byTotal": [{"query": "SELECT … FROM invoices WHERE org_id = $1 ORDER BY issued_at DESC OFFSET $2", "calls": round(18_400 * mult), "meanMs": 412, "totalS": round(7580 * mult)},
                                     {"query": "UPDATE payment_attempts SET status = $1 WHERE id = $2", "calls": round(96_000 * mult), "meanMs": 9, "totalS": round(864 * mult)}],
                          "byMean": [{"query": "SELECT … FROM invoices WHERE org_id = $1 ORDER BY issued_at DESC OFFSET $2", "calls": round(18_400 * mult), "meanMs": 412, "totalS": round(7580 * mult)}]}}],
        "auth": {"firebaseProject": project, "ok": round(9_800 * mult), "err4xx": round(120 * mult), "err5xx": 0, "hourly": curve(400 * mult), "hourlyErr": curve(5 * mult), "link": "#"},
        "errors": errors, "issues": issues, "health": "warn" if issues else "ok",
        "links": {"console": "https://console.cloud.google.com", "logs": "https://console.cloud.google.com/logs"},
    }
    return t

err_groups = [
    {"service": "api", "signature": "stripe.error.APIConnectionError: PaymentIntent retrieve timed out", "sample": "stripe.error.APIConnectionError: Request to Stripe timed out (PaymentIntent.retrieve, 5.0s)\n  at app/billing/poller.py:44", "count": 61, "lastSeen": MS(NOW - 6 * 60)},
    {"service": "worker", "signature": "SMTP 421 rate limited by provider", "sample": "smtplib.SMTPResponseException: (421, 'Too many messages, try again later')", "count": 12, "lastSeen": MS(NOW - 2 * H)},
]
eu_errors = {"tenant": "eu", "project": "ledgerly-eu", "total": 73, "groups": err_groups, "hourly": curve(1, 21, 18)}
prod_errors = {"tenant": "prod", "project": "ledgerly-prod", "total": 9, "groups": [{"service": "web", "signature": "TypeError: Cannot read properties of undefined (reading 'currency')", "sample": "TypeError at InvoiceTotals (web/components/InvoiceTotals.tsx:28)", "count": 9, "lastSeen": MS(NOW - 3 * H)}], "hourly": curve(0.4)}
stg_errors = {"tenant": "staging", "project": "ledgerly-staging", "total": 2, "groups": [], "hourly": curve(0.1)}

eu_issues = [{"tenant": "eu", "severity": "bad", "area": "service", "text": "api returned 58 server errors (5xx) in 24h", "facts": ["58 of 61 are PaymentIntent timeouts", "since 14:05"], "series": curve(1, 21, 18), "link": "#"},
             {"tenant": "eu", "severity": "warn", "area": "sql", "text": "a database query averages 0.4s and ran 9,200× in 24h", "facts": ["SELECT … FROM invoices … OFFSET $2"], "link": "#"}]
prod_issues = [{"tenant": "prod", "severity": "warn", "area": "logs", "text": "9 error log entries in 24h", "facts": ["web: Cannot read 'currency'"], "link": "#"}]

cloud = {"fetchedAt": MS(NOW - 90), "authOk": True, "installed": True, "tenants": [
    tenant("prod", "ledgerly-prod", 1.0, 4, prod_issues, prod_errors),
    tenant("eu", "ledgerly-eu", 0.5, 58, eu_issues, eu_errors),
    tenant("staging", "ledgerly-staging", 0.05, 0, [], stg_errors),
]}
for i, iss in enumerate([x for t in cloud["tenants"] for x in t["issues"]]):
    iss["ref"] = f"C{i + 1}"

board_groups = [
    {"key": "api|timeout", "service": "api", "signature": err_groups[0]["signature"], "sample": err_groups[0]["sample"], "total": 61, "byTenant": {"eu": 61}, "lastSeen": MS(NOW - 6 * 60)},
    {"key": "worker|smtp", "service": "worker", "signature": err_groups[1]["signature"], "sample": err_groups[1]["sample"], "total": 12, "byTenant": {"eu": 12}, "lastSeen": MS(NOW - 2 * H)},
    {"key": "web|currency", "service": "web", "signature": prod_errors["groups"][0]["signature"], "sample": prod_errors["groups"][0]["sample"], "total": 9, "byTenant": {"prod": 9}, "lastSeen": MS(NOW - 3 * H)},
]

demo = {
    "dataDir": str(DATA),
    "cloud": cloud,
    "gcp": {"tenants": [prod_errors, eu_errors, stg_errors], "groups": board_groups},
    "limits": {"claude": {"windows": [{"label": "5h", "usedPct": 38}, {"label": "week", "usedPct": 61}], "at": MS(NOW)}, "codex": {"windows": [{"label": "week", "usedPct": 24}], "plan": "pro", "at": MS(NOW)}, "cursor": {"tier": "Pro", "at": MS(NOW)},
               "today": {"claude": 2_380_000, "codex": 840_000, "cursor": 192_000}},
    "gcloud": {"installed": True, "account": "maya@ledgerly.dev", "userOk": True, "adcOk": True, "checkedAt": MS(NOW)},
    "routines": [
        {"id": "claude:dependency-audit", "engine": "claude", "name": "Weekly dependency audit", "schedule": "Mon 9:00 AM", "enabled": True, "nextRun": MS(NOW + 2 * D), "lastRun": MS(NOW - 5 * D), "cwd": str(REPO), "file": str(REPO / "README.md")},
        {"id": "codex:flaky-tests", "engine": "codex", "name": "Nightly flaky test report", "schedule": "daily 2:00 AM", "enabled": True, "nextRun": MS(NOW + 9 * H), "lastRun": MS(NOW - 15 * H), "cwd": str(REPO), "file": str(REPO / "README.md")},
    ],
    "headline": "One fix to review, the dunning backfill waiting on prod and EU, and Stripe timeouts on EU (not ours).",
    "summaries": {
        "Fix duplicate invoice emails on retry": "Fixed double emails on payment retries; needs migration 0046, not committed",
        "Add EU VAT reverse charge to checkout": "Adding VAT IDs and reverse charge for EU B2B",
        "Dunning schedule backfill for past-due accounts": "Merged; live on staging, prod and EU deploy + backfill pending",
        "Speed up the invoice list": "Invoice list p95 3.4s → 180ms; ready for review",
        "Rotate Stripe webhook secrets": "Webhook secret rotation shipped everywhere",
        "SDK: typed pagination helpers": "SDK 1.9.0 merged; needs npm publish",
        "Flaky checkout end-to-end test": "Waits for Stripe's iframe; 200/200 local runs pass",
        "faster-invoice-list": "Keyset pagination + index for the invoice list",
        "eu-vat-reverse-charge": "EU VAT reverse charge, in progress",
        "fix-duplicate-invoice-emails": "Duplicate invoice email fix, uncommitted",
        "flaky-checkout-e2e": "Checkout e2e wait fix, uncommitted",
        err_groups[0]["signature"]: "Stripe API latency in eu-west; payments recovered on retry",
        err_groups[1]["signature"]: "Email provider throttling during the dunning run",
        prod_errors["groups"][0]["signature"]: "Invoices without a currency crash the totals widget",
    },
    "nextSteps": {
        "Fix duplicate invoice emails on retry": [
            {"label": "Run 0046 on staging", "message": "Run migration 0046 on staging and check the column is there."},
            {"label": "Write the backfill", "message": "Write the backfill that sets paid_email_sent_at = paid_at for invoices already paid."},
            {"label": "Commit and open a PR", "message": "Commit this with a clear message and open a PR against main."},
        ],
        "Speed up the invoice list": [
            {"label": "Merge it", "message": "Merge this into main."},
            {"label": "Benchmark on prod data", "message": "Benchmark the new query against a copy of prod data."},
        ],
    },
    "status": {"Add EU VAT reverse charge to checkout": "running"},
    "shots": {"dir": str(ROOT / "shots")},
}
# ── mail: a made-up inbox ───────────────────────────────────────
def thread(tid, subject, frm, email, snippet, ago, unread=False, starred=False, important=False, count=1, last_from_me=False):
    return {"id": tid, "subject": subject, "snippet": snippet, "from": frm, "lastFrom": "me" if last_from_me else frm, "lastFromMe": last_from_me,
            "date": MS(NOW - ago), "count": count, "unread": unread, "starred": starred, "important": important, "inInbox": True, "_email": email}
inbox_threads = [
    thread("t1", "Charged twice for INV-2041?", "Priya Raman", "priya@northgatecoffee.com", "Hi Maya, we got two receipts for the same invoice this morning and our card shows one charge pending…", 25 * 60, unread=True, important=True),
    thread("t2", "Re: Pilot pricing for 40 locations", "Daniel Okafor", "daniel@harborfit.co", "Thanks for the call. If we can do annual billing at the tier we discussed, I think we're good to go…", 2 * H, unread=True, important=True, count=4),
    thread("t3", "Your payout of $18,420.55 is on the way", "Stripe", "notifications@stripe.com", "Expected to arrive in your bank account by Nov 11.", 3 * H),
    thread("t4", "Security review questionnaire", "Elena Petrova", "elena@brightlane.io", "Our security team sent over the attached questionnaire ahead of the rollout. Could you take a look by Friday?", 5 * H, starred=True, important=True),
    thread("t5", "[ledgerly/ledgerly] PR #482: Keyset pagination for the invoice list", "GitHub", "notifications@github.com", "Review requested from you.", 6 * H),
    thread("t6", "Re: EU VAT question", "Lukas Brandt", "lukas@brandt-steuer.de", "For B2B within the EU the reverse charge applies when the customer gives you a valid VAT ID…", 8 * H, count=3),
    thread("t7", "Weekly metrics: MRR up 6.2%", "Ledgerly Reports", "reports@ledgerly.dev", "MRR $148,900 · net revenue retention 112% · churn 1.4%", 10 * H),
    thread("t8", "Offsite dates", "Sam Whitfield", "sam@ledgerly.dev", "Leaning toward the week of Dec 8. Does that work for the eng team?", 20 * H, count=2, last_from_me=True),
    thread("t9", "Invoice for October hosting", "Render Cloud Billing", "billing@cloud-invoices.example", "Your invoice for October is ready.", 26 * H),
    thread("t10", "Intro: Jordan at Fernway Logistics", "Avery Kim", "avery@kimventures.vc", "Jordan runs finance at Fernway and is looking for a better way to invoice their carriers…", 30 * H, starred=True),
]
thread_details = {
    "t1": {**{k: v for k, v in inbox_threads[0].items() if not k.startswith("_")}, "messages": [
        {"id": "m1", "from": "Priya Raman", "fromEmail": "priya@northgatecoffee.com", "fromMe": False, "to": "Maya Chen <maya@ledgerly.dev>", "cc": "", "date": MS(NOW - 25 * 60),
         "text": "Hi Maya,\n\nWe got two receipts for invoice INV-2041 this morning, and our card shows a second charge pending. Can you check whether we were billed twice? We're on the monthly plan for our three shops.\n\nThanks,\nPriya\nNorthgate Coffee", "attachments": [], "unread": True},
    ]},
}
for t in inbox_threads[1:]:
    thread_details[t["id"]] = {**{k: v for k, v in t.items() if not k.startswith("_")}, "messages": [
        {"id": f"m-{t['id']}", "from": t["from"], "fromEmail": t["_email"], "fromMe": False, "to": "Maya Chen <maya@ledgerly.dev>", "cc": "", "date": t["date"], "text": t["snippet"], "attachments": [], "unread": t["unread"]}]}
demo["mail"] = {
    "email": "maya@ledgerly.dev",
    "inbox": {"fetchedAt": MS(NOW), "query": "", "page": 0, "pageSize": 50, "threads": [{k: v for k, v in t.items() if not k.startswith("_")} for t in inbox_threads if not t["starred"]],
              "starred": [{k: v for k, v in t.items() if not k.startswith("_")} for t in inbox_threads if t["starred"]], "hasNext": False, "total": 38, "importantUnread": 2},
    "threads": thread_details,
    "drafts": {"t1": "Hi Priya,\n\nSorry about that, and thanks for flagging it. You were only billed once for INV-2041: the second email was a duplicate receipt from a payment retry, and the pending charge will drop off your card within a few days without settling.\n\nWe found the cause this morning and the fix goes out today, so it won't happen again.\n\nMaya"},
}
state["sessions"].append(session("Mail", "claude", None, "claude-sonnet-5-5", 30 * 60, [
    item("user", "what needs a reply today?", NOW - 32 * 60),
    item("assistant", "Two people are waiting on you:\n\n- **Priya Raman** (Northgate Coffee) thinks she was charged twice for INV-2041. It's the duplicate retry email; the fix is in progress.\n- **Daniel Okafor** (HarborFit) is ready to sign if annual billing works at the tier you discussed.\n\nElena's security questionnaire is due Friday. The rest are FYIs.", NOW - 30 * 60),
], extra={"isEmail": True, "titleSource": "user", "cwd": str(HOME)}, cost=0.21, tokens=58_000, active=MS(48)))
# ── calendar: today's meetings ───────────────────────────────────
def at(hour, minute=0, days=0):
    t = time.localtime(NOW + days * D)
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, hour, minute, 0, 0, 0, -1))
def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)) + time.strftime("%z", time.localtime(ts))[:3] + ":" + time.strftime("%z", time.localtime(ts))[3:]
def event(eid, title, start, mins, people, location=None):
    return {"id": eid, "calendarId": "primary", "title": title, "start": iso(start), "end": iso(start + mins * 60), "allDay": False, "location": location,
            "attendees": [{"email": "maya@ledgerly.dev", "self": True, "response": "accepted"}] + [{"email": e, "name": n, "response": "accepted"} for n, e in people],
            "myResponse": "accepted", "organizerSelf": False, "recurring": False, "meetLink": "https://meet.example.com/abc-defg-hij"}
now_h = time.localtime(NOW).tm_hour
nxt = max(now_h + 1, 9)
demo["calendar"] = [
    event("e1", "Eng standup", at(9, 30), 15, [("Sam Whitfield", "sam@ledgerly.dev"), ("Theo Grant", "theo@ledgerly.dev")]),
    event("e2", "HarborFit: pilot pricing", at(nxt if nxt < 23 else 22, 0), 30, [("Daniel Okafor", "daniel@harborfit.co")]),
    event("e3", "Billing roadmap review", at(min(nxt + 1, 23), 30), 45, [("Sam Whitfield", "sam@ledgerly.dev")]),
    event("e4", "1:1 Theo", at(10, 0, 1), 30, [("Theo Grant", "theo@ledgerly.dev")]),
]

# ── Linear: your issues ──────────────────────────────────────────
def issue(n, title, prio, status, stype, project, labels, ago):
    plabel = {1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}[prio]
    color = {"started": "#f2c94c", "unstarted": "#bec2c8", "backlog": "#95a2b3"}[stype]
    return {"id": f"iss-{n}", "identifier": f"LED-{n}", "title": title, "priority": prio, "priorityLabel": plabel, "url": f"https://linear.example.com/ledgerly/issue/LED-{n}",
            "createdAt": MS(NOW - ago - 3 * D), "updatedAt": MS(NOW - ago), "status": status, "statusType": stype, "statusColor": color, "assignee": "Maya Chen",
            "project": project, "team": "LED", "labels": [{"name": l, "color": "#5e6ad2"} for l in labels]}
demo["linear"] = {"name": "Maya Chen", "email": "maya@ledgerly.dev", "issues": [
    issue(318, "Customers get the invoice email twice on payment retries", 1, "In Progress", "started", "Billing reliability", ["bug"], 40 * 60),
    issue(322, "EU VAT reverse charge for B2B customers", 2, "In Progress", "started", "EU launch", ["feature"], 2 * H),
    issue(305, "Invoice list is slow for large orgs", 3, "In Review", "started", "Billing reliability", ["performance"], 19 * H),
    issue(311, "Backfill dunning schedule for past-due accounts", 3, "Todo", "unstarted", "Dunning", ["data"], 1 * D),
    issue(326, "Publish SDK 1.9.0 with pagination helpers", 3, "Todo", "unstarted", "SDK", [], 3 * D),
    issue(299, "Flaky checkout e2e on CI", 4, "Todo", "unstarted", "Billing reliability", ["ci"], 26 * H),
    issue(287, "Usage-based pricing: metering design doc", 4, "Backlog", "backlog", "Pricing", ["design"], 5 * D),
    issue(330, "Webhook secret rotation runbook", 4, "Backlog", "backlog", "Platform", ["docs"], 4 * D),
]}

(DATA / "hub-state.json").write_text(json.dumps(state))
(ROOT / "demo.json").write_text(json.dumps(demo))
print(f"seeded {ROOT}")
