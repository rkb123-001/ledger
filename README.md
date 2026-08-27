# Ledger

Project budgeting, multi-account tracking, and costing prediction for an independent practice — artist, designer, researcher, anyone whose income arrives in irregular lumps against work that has to be costed before it is priced.

Ledger answers three questions that a general-purpose budgeting app cannot: what a given piece of work will actually cost to produce, where money already received is committed before it is spent, and whether a project in flight is going to land inside its budget. It runs as an installed app on a phone, against a single-user Postgres database.

Live at `budget.rebekahkosonenbide.com`. Single user by design.

---

## What it does

**Accounts.** Any number of accounts, each with a name, a type, and a balance. Types carry meaning rather than being labels: `current` and `cash` are spendable, `savings` is held back deliberately, `credit` is owed out, and `incoming` is money due but not yet received. Incoming is never counted toward what is available, because a balance that includes money which has not arrived is the specific way this kind of tool causes an overdraft.

Roles are positional rather than hardcoded. The first active spendable account is the primary one that transfers are pulled from; anything else spendable is a buffer used before the primary is touched.

**Pots.** Income is allocated into named categories, each holding a balance and a set of line items with paid checkboxes. Money is committed at the point it arrives rather than at the point it is spent, so the visible balance is what is genuinely free.

**Projects.** A project carries a client, a reference, a status, an optional budget ceiling, a target margin, and a due date. Costs in any pot can be assigned to a project, and quotes can be attached to one. Each project then shows paid, committed, and predicted final spend against its ceiling, with a health band and the variance against what was originally quoted.

A project without a budget is tracked but not capped, and reports `No budget set` rather than a fabricated percentage.

**Order costing.** Per-job costing built from a rate card the practice defines for itself — materials, fabrication, outside services, finishing, labour, whatever the work actually consumes. Every entry is stored as a low/high range rather than a fixed price, because these are the costs that genuinely vary per job. The result is a production subtotal, a margin multiplier, and a suggested retail price with warnings. Where the enquiry is for a piece that already has a published price, the catalogue takes over the pricing question and the costing becomes a margin check instead.

**Committing a single rate.** Not every cost arrives as a whole order. Any line on the rate card can be put straight into a pot from the rate card itself, assigned to a project if one is picked, without going through a quote first. Because the card holds ranges and a pot item holds one number, the control asks which end of the range is being committed to — low, mid or high, each shown as the actual figure at the chosen quantity — rather than collapsing the range silently. Anything drawn from a spread lands flagged as an estimate; a settled price, where low and high agree, lands as a fact. The project defaults to whichever was used last, because costing a job in practice means adding several rates in one sitting.

The card ships empty and stays empty until someone fills it. Categories are the names a practice uses for its own work, so they are yours to write: click a category heading to rename it and every rate inside moves with it, and renaming onto an existing name merges the two after asking. No migration seeds a rate card. `supabase/examples/` holds one working practice's card as a worked example of what a filled-in card looks like, but nothing runs it and nothing depends on it.

**Rate blocks.** A block is a named, reusable set of rate card lines — the costs of one kind of work, kept so they can be laid down again on a future card without being retyped. Any category, or a whole card, can be saved as one; applying a block adds its lines and changes nothing already there.

Ledger ships with no blocks at all, and the migration that creates the table seeds nothing. That is the point rather than an omission: the application does not get to decide what kind of practice you have, so the only blocks that exist are ones a user built and chose to keep. A block carries its own categories, or collapses into a single named one at the moment it is applied.

**Catalogue.** Pieces already listed for sale are synced from Shopify, one row per sellable variant, and handed to the costing model alongside the rate card. When an enquiry names a listed piece, the costing reports the published price and the margin that price now carries, rather than inventing a second number beside one that has already been decided.

This is the distinction the feature exists to draw. For a bespoke commission the useful question is what to charge. For a catalogue piece it is whether what you already charge still works, because metal and casting costs move under a published price without anyone deciding anything. A margin that has thinned below the floor is flagged; a healthy one is left alone. The from-scratch figure is still shown, quietly, because a persistent gap between it and the listed price is the early warning that the price needs revisiting.

Matches carry a confidence. An exact match names the piece and all its options; anything looser says so and adds a warning, because a confident wrong match is worse than an admitted uncertain one.

**Studio hours.** Every pot item carries estimated studio hours alongside its cost, and the outstanding total is simply the hours on items not yet ticked off. The tile converts that into whole bench days, since eleven hours is easier to plan against as two days than as a number.

Hours ride on the same object as the money and clear in the same gesture, so marking a job done removes both at once. That is deliberate: a separate time tracker sitting beside the work is the arrangement that always drifts out of step, and a stale hours figure is worse than none. For a practice of one the bench is usually the binding constraint rather than the bank, so this belongs next to the money rather than in a tool of its own.

**Costing prediction.** Described in its own section below.

**Screenshot parsing.** Two separate intakes, both routed through review. A task list or banking screenshot proposes pot line items, costs already committed. A client order or brief goes to the costing path instead, pricing work not yet taken on. Both are parsed by a vision model that proposes rather than writes: proposals land in `budget_drafts` and appear in a review queue, and nothing enters the ledger without being confirmed.

---

## The prediction model

A quote is a range, not a number, because the rate card stores every input as a low/high pair. Two things happen to that range.

**It is calibrated against history.** Estimates drift in a consistent direction for a given practice. `budget_prediction_factor()` measures that drift as the median ratio of actual to quoted production cost across closed jobs. Above 1 means work has historically cost more than quoted, so new quotes are scaled up.

Three properties of that function matter more than the arithmetic:

- It returns exactly `1.0` until at least three jobs have closed. The honest default is no correction, not a flattering one derived from a single data point.
- It uses the median, not the mean, and discards ratios outside 0.25 to 4.0. One mis-keyed figure cannot skew every future quote.
- The UI states the factor and the sample size it rests on, so a prediction never arrives without its provenance.

**Only the uncertain part is adjusted.** When predicting where a project will land, amounts already paid are facts and are never touched by the factor. Only the still-estimated portion is scaled. This keeps predictions from drifting on projects that are nearly closed, where most of the spend is already known.

The maths lives in `src/lib/predict.ts` as pure functions with no React, no database, and no clock. That is deliberate: this is the part of the app where being wrong costs real money, so it is the part that is directly testable. `npm test` runs 46 cases over it and its neighbour, including the degenerate ones (zero multiplier, non-finite factor, fully-paid project, uncapped budget, a rate card row typed in the wrong order).

Collapsing a rate card range into one committable figure is part of that same surface, so it lives there too rather than in a click handler. `allocateFromRate()` decides what a range plus a quantity is worth, and whether the result should still count as an estimate — which matters downstream, because the calibration above only ever adjusts the estimated portion of a project's spend.

`src/lib/rateblocks.ts` is held to the same rule for the same reason. Saving a block and applying one are both lossy: saving strips row identity, and applying has to invent what the block does not carry — a category for a line that has none, a sort order that appends rather than collides. Both directions corrupt a rate card quietly when they are wrong, so both are pure functions with tests rather than logic inside a click handler.

---

## Why it is built this way

**A model may read but may not write.** Screenshot parsing is useful and is also wrong often enough that trusting it silently would corrupt the ledger over months in ways that are expensive to unpick. Routing every parse through a drafts table and a human review step keeps the speed and confines the error surface to a queue that is visibly pending.

**Allocation happens on receipt.** A single balance figure invites a practice to spend money already owed to materials, tax, or work not yet delivered. Pots make the commitment structural rather than remembered.

**Scope discipline.** This is explicitly a single-user tool. The signup form is hidden, only one hardcoded address can authenticate, and every table carries a row-level security policy restricting access to `auth.uid()`. Building it for one user meant the security model could be simple enough to actually verify, which is a better outcome than a general multi-tenant design nobody audits.

**The deploy and the migration are decoupled.** The frontend reads the project and account tables defensively. If they are absent, the app falls back to the previous fixed-column account row and hides the projects panel instead of throwing. This means a push to Vercel cannot break the live app just because the migration has not been run yet.

The accompanying diagram `ledger-system.html` renders the flow as a Vester-style window picture.

---

## Data model

| Table | Holds |
|---|---|
| `budget_bank_accounts` | one row per real account, with a kind that determines how it is counted |
| `budget_projects` | project, client, status, optional budget ceiling, target margin, due date |
| `budget_pots` | savings categories with current balance |
| `budget_items` | line items inside pots, with cost, estimated studio hours, paid and estimate flags, optionally assigned to a project |
| `budget_catalogue` | one row per sellable variant, synced from Shopify, with its published price |
| `budget_production_costs` | the rate card, each input as a low/high range |
| `budget_rate_blocks` | reusable sets of rate card lines; ships empty by design |
| `budget_order_quotes` | saved quotes, with actual outturn recorded on close |
| `budget_drafts` | pending suggestions from screenshot parsing, awaiting review |
| `budget_accounts` | the original fixed-column account row, retained for fallback |

| View / function | Purpose |
|---|---|
| `budget_project_rollup` | committed, paid, estimated and quoted totals per project |
| `budget_prediction_factor(uuid)` | median actual-to-quoted ratio over closed jobs |

All tables have RLS policies restricting access to `auth.uid()`. The rollup view is declared `security_invoker` so it is filtered by the querying user's policies rather than the view owner's.

---

## Stack

- Vite + React + TypeScript, strict mode
- Supabase for auth, Postgres, edge functions and storage
- Anthropic API (vision) via Supabase Edge Functions for screenshot parsing and order costing
- Shopify Admin GraphQL API for the catalogue sync
- Vitest for the prediction tests
- Vercel hosting on a custom subdomain
- PWA enabled, installs to iOS home screen

Running costs sit inside the free tiers for Supabase and Vercel. Screenshot parsing costs roughly £0.01 to £0.03 per parse, around £1 per month at typical usage.

---

## Setup

### 1. Migrations

Run the SQL files in `supabase/migrations/` in order in the Supabase SQL Editor. Everything from `005_projects_and_accounts.sql` onward is additive only: new tables, nullable columns, backfills. Nothing is dropped and all are safe to run more than once. `007_catalogue.sql` adds the Shopify catalogue, `008_catalogue_upsert_fix.sql` corrects its uniqueness constraint, and `009_studio_hours.sql` adds hours to pot items.

Each migration grants on its own tables explicitly. This is not decoration: a table created without grants is invisible to PostgREST, which answers `404` rather than a permissions error, and the app reads that as an unmigrated database and silently falls back. That failure took a long afternoon to diagnose once.

No migration seeds a rate card or a set of pots. `002_seed_data.sql` is an optional example dataset with invented figures, and `supabase/examples/rate-card-metalwork.sql` is one practice's real card kept as a worked example. Neither is run by anything; both have to be pasted deliberately, and both want your own `auth.users.id` in place of the placeholder. Any file matching `*.local.sql` is ignored by git and never committed — that is where a real practice's own figures belong.

### 2. Edge functions

Three functions, all deployed with `--no-verify-jwt` because each checks the `Authorization` header itself.

```bash
supabase functions deploy parse-screenshot --no-verify-jwt --project-ref YOUR_PROJECT_REF
supabase functions deploy cost-order       --no-verify-jwt --project-ref YOUR_PROJECT_REF
supabase functions deploy sync-catalogue   --no-verify-jwt --project-ref YOUR_PROJECT_REF

supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref YOUR_PROJECT_REF
```

The catalogue sync additionally needs Shopify credentials:

```bash
supabase secrets set SHOPIFY_STORE_DOMAIN=yourstore.myshopify.com --project-ref YOUR_PROJECT_REF
supabase secrets set SHOPIFY_CLIENT_ID=... --project-ref YOUR_PROJECT_REF
supabase secrets set SHOPIFY_CLIENT_SECRET=shpss_... --project-ref YOUR_PROJECT_REF
```

Create the app in the Shopify **Dev Dashboard**, give it the `read_products` scope, release a version, and install it on the store. Admin-created custom apps and their permanent `shpat_` tokens were deprecated on 1 January 2026; Dev Dashboard apps exchange a client ID and secret for a token lasting 24 hours, which `sync-catalogue` does per run rather than caching. This works because app and store sit in the same Shopify organisation. Across organisations it would need a full OAuth flow instead.

### 3. Environment variables

Copy `.env.example` to `.env.local` and fill in:

```
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_ALLOWED_EMAIL=your.email@example.com
```

Set the same three in Vercel under Project Settings, Environment Variables.

### 4. Local development

```bash
npm install
npm run dev
npm test
```

### 5. Deploy

Push to GitHub, import into Vercel, point the subdomain CNAME at Vercel. Further detail in `DEPLOY.md`.

### Things that expire

Two external identifiers in this codebase have a shelf life, and both fail in ways that do not name themselves.

**Model IDs.** The functions pin an Anthropic model. When one is retired the API returns `not_found_error` and the app reports only that the call failed. List what is currently available with:

```bash
curl -s https://api.anthropic.com/v1/models -H "x-api-key: KEY" -H "anthropic-version: 2023-06-01"
```

**Shopify API versions.** `sync-catalogue` defaults to a version and accepts a `SHOPIFY_API_VERSION` secret to override it without a code change. A retired version returns `404`, which reads like a missing endpoint rather than an expiry.

### Auth

Single user. The signup form is hidden and only `VITE_ALLOWED_EMAIL` can sign in. Create the first account through the Supabase dashboard.

---

Ledger is one of the systems built to run RKB Studio, alongside Studio Planner and Gridwork. Where those two model capacity, this one models money, on the same principle: that the infrastructure a practice runs on is a site of design in its own right.
