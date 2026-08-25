# Deployment Guide

Step-by-step. Follow in order.

## 1. Get your Anthropic API key

1. Go to https://console.anthropic.com
2. Sign up or sign in
3. Settings → API Keys → Create key
4. Copy the key (starts with `sk-ant-...`). You only see it once — store it somewhere safe.
5. Add ~£5 of credit to your account (Settings → Billing). At ~£0.01-0.03 per screenshot parse, this lasts months.

## 2. Set up Supabase tables

Use your existing Practice Planner Supabase project.

1. Open the project in https://supabase.com/dashboard
2. Go to SQL Editor → New query
3. Run the migration files in `supabase/migrations/` in numerical order:
   `001_initial_schema.sql`, `003_order_costing.sql`, `004_enable_realtime.sql`,
   then `005_projects_and_accounts.sql`. Copy each into the editor and run it.
   (`002_seed_data.sql` is optional and covered in step 4.)
4. You should see "Success. No rows returned." after each.

`005_projects_and_accounts.sql` adds projects and multi-account tracking.
It is additive only and safe to run more than once.

## 3. Create your auth user

1. In Supabase dashboard → Authentication → Users → Add user
2. Choose "Send email invite" or "Create with password"
3. Use the email you want to log in with
4. Note the User ID (under the user's row)

## 4. Seed your starting data (optional but recommended)

1. Open `supabase/migrations/002_seed_data.sql`
2. Replace `YOUR_USER_ID_HERE` near the top with the User ID from step 3
3. Paste the whole file into Supabase SQL Editor and run.

This pre-fills all your current pots and items. Skip this step if you'd rather start empty.

## 5. Deploy the Edge Function

Install Supabase CLI if you don't have it:

```bash
brew install supabase/tap/supabase
```

Login and link:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Find your project ref in Supabase dashboard → Project Settings → General → Reference ID.

Deploy the function:

```bash
supabase functions deploy parse-screenshot --no-verify-jwt
```

(We use `--no-verify-jwt` because the function does its own auth check via the Authorization header.)

Set the API key secret. Paste the real key straight into the terminal.
Never write it into this file or any other tracked file: an earlier version
of this guide had a live key committed, which is why it now says
YOUR_ANTHROPIC_API_KEY.

```bash
supabase secrets set ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY
```

## 6. Push the frontend to GitHub

```bash
cd /path/to/this/folder
git init
git add .
git commit -m "Initial commit"
gh repo create ledger --private --source=. --push
```

(Or create the repo manually on GitHub and push.)

## 7. Deploy to Vercel

1. Go to https://vercel.com/new
2. Import the GitHub repo
3. Framework preset: Vite (auto-detected)
4. Environment Variables — add these three:
   - `VITE_SUPABASE_URL` = your Supabase project URL (Settings → API)
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon key
   - `VITE_ALLOWED_EMAIL` = the email you set up in step 3
5. Click Deploy

## 8. Add the custom subdomain

1. In Vercel project → Settings → Domains
2. Add `budget.rebekahkosonenbide.com`
3. Vercel gives you a CNAME record to add at your domain registrar
4. Add the CNAME at wherever rebekahkosonenbide.com is registered
5. Wait a few minutes for DNS to propagate

## 9. Add to home screen on iPhone

1. Open `https://budget.rebekahkosonenbide.com` in Safari
2. Sign in
3. Tap the share button → "Add to Home Screen"
4. The app icon appears on your home screen and runs in standalone mode

## Troubleshooting

**Login says "not authorised"** — your `VITE_ALLOWED_EMAIL` env var doesn't match the email you signed up with. Update either one to match (case-insensitive).

**Edge function returns 500 "Server not configured"** — the `ANTHROPIC_API_KEY` secret isn't set. Run the `supabase secrets set` command from step 5.

**Edge function returns "Could not parse model output as JSON"** — happens occasionally with messy screenshots. Try a clearer screenshot.

**Drafts don't appear after upload** — check Supabase dashboard → Table Editor → budget_drafts. If rows are there but UI doesn't show them, the page may need a manual refresh.

**Estimated cost check** — you can monitor usage in https://console.anthropic.com/settings/usage. Each screenshot costs about £0.01-0.03 depending on size.
