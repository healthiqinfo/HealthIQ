# HealthIQ — Supabase Edge Functions

Server-side functions that need secrets (SMTP credentials, etc.) live here.

| Function | Purpose |
|---|---|
| `send-decline-email` | Emails the user via Gmail SMTP when admin clicks **Decline & Notify User**. |

---

## 🚨 Security model

> **NO SECRETS IN THIS REPO.** Anything sensitive (Gmail app password,
> service role key, etc.) is stored in **Supabase Edge Function Secrets**,
> which are encrypted at rest and only injected as env vars at runtime.
> See `.gitignore` at the repo root — `.env`, `.env.*`, `supabase/.env`
> are all blocked.

If you ever accidentally commit a secret:
1. **Revoke it immediately** at the source (Google → App Passwords / Supabase → API).
2. Generate a new one.
3. Use `git filter-repo` to scrub history (or rotate and move on if the
   leak window was small).

---

## 🔧 One-time setup

### 1. Install the Supabase CLI

```powershell
# Windows (Scoop)
scoop install supabase

# OR download from
# https://github.com/supabase/cli/releases
```

Verify:
```powershell
supabase --version
```

### 2. Log in & link your project

```powershell
supabase login
supabase link --project-ref ejpwabynzdjfecsrgumh
```

The project ref is the subdomain from your Supabase URL —
`ejpwabynzdjfecsrgumh` for HealthIQ.

### 3. Set the SMTP secrets (one time, never again unless you rotate)

> ⚠️ Generate a **fresh** Gmail App Password at
> https://myaccount.google.com/apppasswords. Revoke any password that
> has ever been pasted in chat / shared in plain text. Use the new one.

```powershell
supabase secrets set `
    GMAIL_USER=thehealthiqinfo@gmail.com `
    GMAIL_APP_PASSWORD="abcd efgh ijkl mnop"
```

> 🪟 **PowerShell tip:** wrap the app password in double quotes if it
> contains spaces. The 16-character code Google gives you typically
> displays as `abcd efgh ijkl mnop` — paste it exactly as Google
> showed it (with or without spaces; SMTP accepts both).

Verify the secrets are set (without printing values):
```powershell
supabase secrets list
```

You should see `GMAIL_USER` and `GMAIL_APP_PASSWORD` in the list.

### 4. Deploy the function

```powershell
supabase functions deploy send-decline-email --no-verify-jwt
```

The `--no-verify-jwt` flag is **intentional** — we do our own
admin-role check inside the function (Supabase's built-in JWT gate
would reject anon requests before our code runs, which is
fine for security but makes debugging confusing because the
response body is empty).

### 5. Smoke-test

In any browser console at https://healthiqinfo.github.io/HealthIQ
**while logged in as an admin**:

```js
const { data, error } = await db.functions.invoke('send-decline-email', {
    body: {
        to: 'your-test-inbox@example.com',
        userName: 'Test User',
        courseTitle: 'Smoke Test Course',
        amount: 999,
        reason: 'This is a smoke test, please ignore.'
    }
});
console.log({ data, error });
```

You should see `{ ok: true, sent_to: 'your-test-inbox@example.com' }`
and an email arrives at the test inbox within ~10 seconds.

---

## 🐛 Troubleshooting

### `Admin role required`
Your `profiles.role` isn't `admin`. Check:
```sql
SELECT id, email, role FROM public.profiles WHERE id = auth.uid();
```

### `SMTP secrets not configured`
You skipped Step 3. Run `supabase secrets list` to confirm both
`GMAIL_USER` and `GMAIL_APP_PASSWORD` are present.

### `535-5.7.8 Username and Password not accepted`
Either:
- The app password is wrong (regenerate it — paste the new one without
  surrounding quotes when running `supabase secrets set`).
- 2-Step Verification is OFF on the Gmail account. App passwords only
  work when 2FA is enabled — enable it at
  https://myaccount.google.com/security.
- The Gmail account is a Google Workspace account with SMTP disabled
  by your admin. Switch to a personal Gmail or have IT enable
  "Less secure SMTP" (not recommended) or use a dedicated relay
  service like Resend / SendGrid instead.

### `Connection refused / timeout`
Supabase's Deno runtime allows outbound connections to standard
SMTP ports (465, 587). If you customised egress, re-allow them.

### Function logs

```powershell
supabase functions logs send-decline-email --tail
```

Streams live logs while you test. The function intentionally
**redacts long base64-looking strings** in error messages so the
SMTP password doesn't leak even if denomailer surfaces it in an
exception.

---

## 🔄 Updating

After editing `index.ts`:
```powershell
supabase functions deploy send-decline-email --no-verify-jwt
```

Re-running `supabase secrets set` is **only** needed when you rotate
the Gmail password.

---

## 🧠 Why Gmail SMTP and not Resend / SendGrid?

For now: zero-cost, instant setup, you already own the inbox.

**Limits to know about:**
- ~500 emails / day per Gmail account
- ~100 recipients per email (we always send 1-to-1, so irrelevant)
- Deliverability is good for personal Gmail; "noreply@yourdomain.com"
  via a transactional ESP is better long-term.

When HealthIQ outgrows free Gmail (or you want to move to
`noreply@healthiq.info`), swap the SMTP block in `index.ts` to
Resend / SendGrid / Postmark — same denomailer client, different
host/port/credentials.
