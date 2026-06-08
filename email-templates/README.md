# HealthIQ — Supabase Email Templates

Premium, brand-matched email templates for Supabase Auth.

---

## ⚠️ READ THIS FIRST — Fix the `localhost:3000` redirect bug

If your users are clicking the email confirmation link and landing on a URL
like `http://localhost:3000/#error=access_denied&error_code=otp_expired`,
**the bug is NOT in the email template — it's in your Supabase project's URL
Configuration**. Here's the fix:

### 🛠️ The dashboard fix (do this once)

> **HealthIQ is hosted on GitHub Pages at:**
> `https://healthiqinfo.github.io/HealthIQ`
> The exact values you need to paste are below.

1. Open the [Supabase Dashboard](https://supabase.com/dashboard) → your project.
2. Go to **Authentication → URL Configuration**.
3. **Site URL** — paste this **exactly** (note: no trailing slash):
   ```
   https://healthiqinfo.github.io/HealthIQ
   ```
4. **Redirect URLs** — paste these (one per line). All four are needed to
   cover the three ways a user can land on the site (with `/`, without `/`,
   or with `/index.html`) plus a wildcard catch-all for any future sub-paths:
   ```
   https://healthiqinfo.github.io/HealthIQ
   https://healthiqinfo.github.io/HealthIQ/
   https://healthiqinfo.github.io/HealthIQ/index.html
   https://healthiqinfo.github.io/HealthIQ/**
   ```
   *(Add localhost too if you're still developing locally — for production-only
   sites, skip these:)*
   ```
   http://localhost:3000
   http://localhost:5173
   ```
5. Click **Save**.
6. Inside the app, open **Admin → System → Settings → 🩺 Database Diagnostics**
   and click the **🔐 Auth Setup Helper** button — it displays the same URLs
   computed from `window.location` so you can verify they match.

### Why this happens

When you first create a Supabase project, Site URL defaults to `localhost:3000`
(for local dev). The `{{ .ConfirmationURL }}` token in the email template uses
that Site URL as its base — so the link in the email points at localhost. When
the user clicks it from their phone, they hit a domain that doesn't exist on
their device, and the auth callback fails. Updating Site URL fixes every
future email; existing emails in inboxes will still have the bad URL because
they were generated at send time.

### Why the `otp_expired` error appears even after the dashboard fix

Two reasons:
1. **The link was already clicked once.** Supabase confirmation links are
   one-time-use — the moment the user (or a corporate email security scanner
   like Microsoft Defender / Gmail's safelinks) opens it, it's consumed.
2. **It's been >1 hour.** Confirmation links expire after 1 hour by default.

> **What v1.6.18 adds:** the site now detects this error in the URL hash and
> automatically shows a recovery modal with a one-click "Resend Confirmation
> Email" button — so even when this happens, users aren't stuck.

---

## 📂 Files

| File | Supabase template slot |
|---|---|
| `confirm-signup.html` | **Authentication → Email Templates → Confirm signup** |

## 🚀 How to install

1. Open the [Supabase Dashboard](https://supabase.com/dashboard).
2. Pick your HealthIQ project.
3. Navigate: **Authentication → Email Templates → Confirm signup**.
4. **Subject heading** — paste:
   ```
   Confirm your HealthIQ account ✉️
   ```
5. **Message body** — open `confirm-signup.html`, copy the entire file, and paste it into the editor (replace everything that was there).
6. Click **Save changes**.
7. Trigger a test signup from the live site to confirm everything renders correctly across Gmail (web + iOS + Android), Apple Mail, and Outlook.

## 🎨 Brand language

- **Primary blue:** `#0f6fec` (matches the site `--primary` token)
- **Gradient ribbon:** `#0f6fec → #6366f1 → #8b5cf6` (matches the `.logo` wordmark)
- **Gold accent:** `#fef3c7` / `#92400e` (Gold Medalist badge)
- **Card:** white on `#f5f7fb` page background
- **Typography:** system stack (`-apple-system, Segoe UI, Roboto, ...`) — no remote font load (which most email clients block anyway)

## 🛠️ Email-client safety checklist

- ✅ Full XHTML 1.0 Transitional DOCTYPE (Outlook 2007–2019 friendly)
- ✅ Table-based layout (600px max-width card)
- ✅ All CSS inlined on each tag
- ✅ Outlook VML `<v:roundrect>` for the CTA so the button stays rounded + filled in Outlook 2007+
- ✅ `<meta name="color-scheme">` + `@media (prefers-color-scheme: dark)` for native dark-mode in Apple Mail, iOS Mail, Outlook.com
- ✅ Mobile-responsive via `@media (max-width: 620px)` — CTA goes full-width, padding shrinks, font sizes adapt
- ✅ Hidden preheader text (the inbox snippet preview)
- ✅ Bulletproof button + plain-text URL fallback in a copyable code block
- ✅ Security note ("Didn't sign up?") so recipients can safely ignore phishing-lookalike

## 🔑 Supabase template variables used

| Variable | Purpose |
|---|---|
| `{{ .ConfirmationURL }}` | The one-time signup confirmation link (used by the button + the plain-text fallback) |
| `{{ .Email }}` | Personalises the body ("Tap the button below to verify **email@example.com**") |
| `{{ .SiteURL }}` | Powers the footer links (Visit website, Courses, FAQ) |

> Need more? Supabase also exposes `{{ .Token }}`, `{{ .TokenHash }}`, `{{ .RedirectTo }}`, `{{ .Data }}`. See [docs](https://supabase.com/docs/guides/auth/auth-email-templates).

## 🧪 Testing tips

- **Litmus / Email on Acid** — paste the rendered HTML to preview across 90+ clients.
- **Gmail "spam score"** — keep the HTML under ~100 KB (this template is ~9 KB, well under).
- **Real-device check** — always send to a real Gmail (web + iOS), Outlook 365, and an iPhone Mail.app before going live.
- **Dark-mode preview** — toggle iOS dark mode and re-open the test email; the card should flip to deep navy `#111827` with light text.

## 🪪 Customising the footer

If you change your support email or domain, update these three spots in `confirm-signup.html`:

1. `support@healthiq.info` → your real support address
2. The footer copyright line ("© HealthIQ Academy")
3. The brand tagline if you ever rebrand
