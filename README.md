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

**Order costing.** Per-job costing built from a rate card the practice defines for itself — materials, fabrication, outside services, finishing, labour, whatever the work actually consumes. Every entry is stored as a low/high range rather than a fixed price, because these are the costs that genuinely vary per job. The result is a production subtotal, a margin multiplier, and a suggested retail price with warnings.

**Committing a single rate.** Not every cost arrives as a whole order. Any line on the rate card can be put straight into a pot from the rate card itself, assigned to a project if one is picked, without going through a quote first. Because the card holds ranges and a pot item holds one number, the control asks which end of the range is being committed to — low, mid or high, each shown as the actual figure at the chosen quantity — rather than collapsing the range silently. Anything drawn from a spread lands flagged as an estimate; a settled price, where low and high agree, lands as a fact. The project defaults to whichever was used last, because costing a job in practice means adding several rates in one sitting.

**Costing prediction.** Described in its own section below.

**Screenshot parsing.** Banking screenshots are uploaded and parsed by a vision model, which proposes line items rather than writing them. Proposals land in `draft_items` and appear in a review queue. Nothing enters the ledger without being confirmed.

---

## The prediction model

A quote is a range, not a number, because the rate card stores every input as a low/high pair. Two things happen to that range.

**It is calibrated against history.** Estimates drift in a consistent direction for a given practice. `budget_prediction_factor()` measures that drift as the median ratio of actual to quoted production cost across closed jobs. Above 1 means work has historically cost more than quoted, so new quotes are scaled up.

Three properties of that function matter more than the arithmetic:

- It returns exactly `1.0` until at least three jobs have closed. The honest default is no correction, not a flattering one derived from a single data point.
- It uses the median, not the mean, and discards ratios outside 0.25 to 4.0. One mis-keyed figure cannot skew every future quote.
- The UI states the factor and the sample size it rests on, so a prediction never arrives without its provenance.

**Only the uncertain part is adjusted.** When predicting where a project will land, amounts already paid are facts and are never touched by the factor. Only the still-estimated portion is scaled. This keeps predictions from drifting on projects that are nearly closed, where most of the spend is already known.

The maths lives in `src/lib/predict.ts` as pure functions with no React, no database, and no clock. That is deliberate: this is the part of the app where being wrong costs real money, so it is the part that is directly testable. `npm test` runs 27 cases over it, including the degenerate ones (zero multiplier, non-finite factor, fully-paid project, uncapped budget, a rate card row typed in the wrong order).

Collapsing a rate card range into one committable figure is part of that same surface, so it lives there too rather than in a click handler. `allocateFromRate()` decides what a range plus a quantity is worth, and whether the result should still count as an estimate — which matters downstream, because the calibration above only ever adjusts the estimated portion of a project's spend.

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
| `budget_items` | line items inside pots, with paid and estimate flags, optionally assigned to a project |
| `budget_production_costs` | the rate card, each input as a low/high range |
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
- Anthropic API (vision) via a Supabase Edge Function for screenshot parsing
- Vitest for the prediction tests
- Vercel hosting on a custom subdomain
- PWA enabled, installs to iOS home screen

Running costs sit inside the free tiers for Supabase and Vercel. Screenshot parsing costs roughly £0.01 to £0.03 per parse, around £1 per month at typical usage.

---

## Setup

### 1. Migrations

Run the SQL files in `supabase/migrations/` in order in the Supabase SQL Editor. `005_projects_and_accounts.sql` is additive only: it creates new tables, adds nullable columns, and backfills accounts from the old fixed columns. It drops nothing and is safe to run more than once.

### 2. Edge function

```bash
supabase functions deploy parse-screenshot --project-ref YOUR_PROJECT_REF
supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref YOUR_PROJECT_REF
```

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

### Auth

Single user. The signup form is hidden and only `VITE_ALLOWED_EMAIL` can sign in. Create the first account through the Supabase dashboard.

---

Ledger is one of the systems built to run RKB Studio, alongside Studio Planner and Gridwork. Where those two model capacity, this one models money, on the same principle: that the infrastructure a practice runs on is a site of design in its own right.
