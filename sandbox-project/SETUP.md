# Adding accounts + saved data (Supabase)

## 1. Create the Supabase project (free)
1. Go to supabase.com, sign in with GitHub, click **New project**. Pick any name and a database password, then wait ~2 minutes.
2. Open **SQL Editor > New query**, paste the contents of `supabase.sql`, click **Run**.
3. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key.

## 2. Allow your website address
In **Authentication > URL Configuration**, set **Site URL** to your Vercel address
(https://retirement-runway-sigma.vercel.app) and add the same address under **Redirect URLs**.
(Optional: in Authentication > Providers > Email you can turn off "Confirm email" for instant sign-up.)

## 3. Add the keys in Vercel
Project > **Settings > Environment Variables**, add for Production, Preview and Development:
- `REACT_APP_SUPABASE_URL` = your Project URL
- `REACT_APP_SUPABASE_ANON_KEY` = your anon public key

## 4. Update GitHub and redeploy
Replace the contents of `sandbox-project/` in your repo with these files (package.json, supabase.sql, SETUP.md, and everything in src/ and public/), commit to `main`.
Vercel redeploys automatically. If it doesn't pick up the keys, click **Deployments > ... > Redeploy**.

Existing browser-saved plans are copied into a new account the first time it signs in.
