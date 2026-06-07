# HealthIQ — Supabase Email Templates

Premium, brand-matched email templates for Supabase Auth.

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
