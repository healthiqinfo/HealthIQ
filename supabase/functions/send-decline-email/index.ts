/**
 * HealthIQ — send-decline-email Edge Function
 * ============================================================
 * Sends a branded "your payment was declined" email to a user
 * via Gmail SMTP, server-side. Triggered by the admin clicking
 * "Decline & Notify User" in the in-app decline modal.
 *
 * RUNTIME: Supabase Edge Functions / Deno 1.40+
 * The `@ts-nocheck` below tells your local VS Code TS engine
 * not to flag the remote URL imports + Deno globals — those
 * resolve fine inside Supabase's Deno runtime on deploy.
 *
 * SECURITY MODEL
 * ──────────────
 * 1. Caller authentication: every request must include the
 *    Authorization header carrying the caller's Supabase
 *    access_token. We verify the JWT and look up their profile
 *    in `profiles` — only role='admin' may call this function.
 *
 * 2. Secrets: GMAIL_USER and GMAIL_APP_PASSWORD live in Supabase
 *    Edge Function Secrets — encrypted at rest, never in code,
 *    never in git, never returned in responses or logs.
 *
 * 3. Input validation: we only accept the minimum payload needed
 *    (to, userName, courseTitle, amount, reason). Reason text is
 *    HTML-escaped before being injected into the template so a
 *    malicious admin (or compromised admin token) can't inject
 *    HTML/JS into the email.
 *
 * DEPLOY
 * ──────
 *   supabase login
 *   supabase link --project-ref <YOUR_REF>
 *   supabase secrets set GMAIL_USER=thehealthiqinfo@gmail.com \
 *                         GMAIL_APP_PASSWORD="<16-char-app-pwd-no-spaces>"
 *   supabase functions deploy send-decline-email --no-verify-jwt
 *
 * NOTE on --no-verify-jwt: we disable Supabase's automatic JWT
 * gate because we want to do our OWN verification (we need to
 * also check the admin role, not just "is JWT present"). If you
 * deploy WITHOUT --no-verify-jwt, every anon request gets
 * rejected by Supabase's edge runtime BEFORE hitting our code,
 * which is fine but produces a 401 with no body — confusing for
 * debugging.
 * ============================================================
 */
// @ts-nocheck — file targets Deno runtime; local TS engine isn't Deno-aware.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Tiny HTML escaper — denomailer doesn't sanitize, and the reason
// text comes straight from an admin's free-text input box.
function esc(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatINR(amount: number): string {
    if (!isFinite(amount)) return "";
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }).format(amount);
}

interface DeclinePayload {
    to: string;
    userName?: string;
    courseTitle: string;
    amount: number;
    reason: string;
    siteUrl?: string;
}

function buildHtml(p: DeclinePayload): string {
    const site = p.siteUrl || "https://healthiqinfo.github.io/HealthIQ";
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>HealthIQ — Action needed on your payment</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f5f7fb;opacity:0;">We couldn't verify your recent payment for "${esc(p.courseTitle)}". Here's what to do next.</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f5f7fb;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(15,23,42,0.06);">
      <!-- Brand ribbon -->
      <tr><td style="background:linear-gradient(90deg,#0f6fec,#6366f1,#8b5cf6);padding:20px 28px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:0.4px;">HealthIQ Academy</td></tr>
      <!-- Header -->
      <tr><td style="padding:32px 28px 8px;">
        <h1 style="margin:0;font-size:22px;font-weight:800;color:#0f172a;line-height:1.3;">Action needed on your payment</h1>
        <p style="margin:8px 0 0;font-size:14px;color:#64748b;">Hi ${esc(p.userName || "there")}, we couldn't verify your recent payment.</p>
      </td></tr>
      <!-- Decline card -->
      <tr><td style="padding:20px 28px 0;">
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:18px;">
          <div style="font-size:13px;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:0.6px;">⚠️ Payment Declined</div>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:12px;font-size:14px;color:#0f172a;">
            <tr><td style="padding:4px 0;width:90px;color:#64748b;">Course</td><td style="padding:4px 0;font-weight:600;">${esc(p.courseTitle)}</td></tr>
            <tr><td style="padding:4px 0;color:#64748b;">Amount</td><td style="padding:4px 0;font-weight:600;">${esc(formatINR(p.amount))}</td></tr>
            <tr><td style="padding:4px 0;color:#64748b;vertical-align:top;">Reason</td><td style="padding:4px 0;font-weight:600;color:#991b1b;">${esc(p.reason)}</td></tr>
          </table>
        </div>
      </td></tr>
      <!-- Next steps -->
      <tr><td style="padding:20px 28px 4px;">
        <h2 style="margin:0;font-size:15px;font-weight:700;color:#0f172a;">What to do next</h2>
        <ol style="margin:10px 0 0 18px;padding:0;font-size:14px;color:#334155;line-height:1.6;">
          <li><strong>Check your bank / UPI account.</strong> If the money was deducted, please reply to this email with a clear screenshot of the transaction (showing UTR / reference number).</li>
          <li><strong>If no money left your account,</strong> simply re-initiate the payment from the HealthIQ website — your previous request has been cleared so you can try again immediately.</li>
          <li><strong>Need help?</strong> Reply to this email and we'll personally assist you.</li>
        </ol>
      </td></tr>
      <!-- CTA -->
      <tr><td style="padding:24px 28px 8px;" align="center">
        <a href="${esc(site)}" style="display:inline-block;background:#0f6fec;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:700;font-size:14px;">Open HealthIQ &amp; Try Again</a>
        <p style="margin:12px 0 0;font-size:12px;color:#64748b;">You'll also see this notification in your account when you log in.</p>
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:24px 28px 28px;border-top:1px solid #e2e8f0;margin-top:18px;">
        <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
          You received this email because you submitted a payment for a HealthIQ course at <a href="${esc(site)}" style="color:#0f6fec;text-decoration:none;">${esc(site)}</a>.<br/>
          © HealthIQ Academy &middot; Trusted by 100+ students &middot; By a BHMS Gold Medalist
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildText(p: DeclinePayload): string {
    return [
        `Hi ${p.userName || "there"},`,
        ``,
        `We attempted to verify your recent payment for the course below,`,
        `but we were unable to confirm it on our end.`,
        ``,
        `────────────────────────────`,
        `Course : ${p.courseTitle}`,
        `Amount : ${formatINR(p.amount)}`,
        `Status : Declined`,
        `Reason : ${p.reason}`,
        `────────────────────────────`,
        ``,
        `WHAT TO DO NEXT`,
        `1. Check your bank/UPI. If money was deducted, reply with a`,
        `   screenshot showing UTR/reference number.`,
        `2. If no money left your account, re-initiate the payment from`,
        `   the HealthIQ website — your previous request has been cleared.`,
        `3. Need help? Just reply to this email.`,
        ``,
        `Open HealthIQ: ${p.siteUrl || "https://healthiqinfo.github.io/HealthIQ"}`,
        ``,
        `Warm regards,`,
        `The HealthIQ Team`,
    ].join("\r\n");
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
    }

    try {
        // ─── 1. Caller-must-be-admin gate ───────────────────────
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

        const supabaseUrl = Deno.env.get("SUPABASE_URL");
        const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY");
        if (!supabaseUrl || !supabaseAnon) {
            return jsonResponse({ error: "Server misconfigured (missing SUPABASE_URL/ANON_KEY)" }, 500);
        }

        const supabase = createClient(supabaseUrl, supabaseAnon, {
            global: { headers: { Authorization: authHeader } },
        });

        const { data: userData, error: userErr } = await supabase.auth.getUser();
        if (userErr || !userData?.user) {
            return jsonResponse({ error: "Invalid or expired session" }, 401);
        }

        // ─── 1b. Admin-role check ─────────────────────────────
        // Two acceptable paths to admin (mirrors the client logic in
        // hydrateUserFromSession): (a) profiles.role === 'admin', or
        // (b) the user is the bootstrap admin email. The fallback exists
        // because brand-new Supabase projects often lack a profiles row
        // until the first manual run, which would otherwise lock the
        // founding admin out of their own Edge Functions.
        const ADMIN_EMAIL_FALLBACK = "thehealthiqinfo@gmail.com";
        let isAdmin = false;
        let profileRole: string | null = null;
        const { data: profile } = await supabase
            .from("profiles")
            .select("role")
            .eq("id", userData.user.id)
            .maybeSingle();
        profileRole = profile?.role ?? null;
        if (profileRole === "admin") {
            isAdmin = true;
        } else if (
            (userData.user.email || "").toLowerCase() === ADMIN_EMAIL_FALLBACK.toLowerCase()
        ) {
            isAdmin = true;
        }
        if (!isAdmin) {
            return jsonResponse(
                {
                    error: "Admin role required",
                    debug: {
                        user_email: userData.user.email,
                        profile_role: profileRole,
                        hint: profileRole
                            ? `Your profile has role='${profileRole}'. Run the SQL fix in the dashboard to set it to 'admin'.`
                            : "No profiles row found for your user. Run the SQL fix to create one with role='admin'.",
                    },
                },
                403,
            );
        }

        // ─── 2. Validate payload ────────────────────────────────
        let payload: DeclinePayload;
        try {
            payload = await req.json();
        } catch {
            return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        if (!payload.to || !payload.courseTitle || !payload.reason) {
            return jsonResponse(
                { error: "Missing required fields: to, courseTitle, reason" },
                400,
            );
        }
        // Trivial email shape check — Gmail will reject malformed
        // addresses anyway, but failing fast is cleaner.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.to)) {
            return jsonResponse({ error: "Invalid 'to' email address" }, 400);
        }

        // ─── 3. Read SMTP secrets ───────────────────────────────
        const gmailUser = Deno.env.get("GMAIL_USER");
        const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
        if (!gmailUser || !gmailPass) {
            return jsonResponse(
                {
                    error:
                        "SMTP secrets not configured. Run: supabase secrets set GMAIL_USER=... GMAIL_APP_PASSWORD=...",
                },
                500,
            );
        }

        // ─── 4. Send via Gmail SMTP ─────────────────────────────
        const client = new SMTPClient({
            connection: {
                hostname: "smtp.gmail.com",
                port: 465,
                tls: true,
                auth: { username: gmailUser, password: gmailPass },
            },
        });

        try {
            await client.send({
                from: `HealthIQ Academy <${gmailUser}>`,
                to: payload.to,
                subject: `HealthIQ — Action needed on your payment for "${payload.courseTitle}"`,
                content: buildText(payload),
                html: buildHtml(payload),
            });
        } finally {
            try { await client.close(); } catch (_) { /* best-effort close */ }
        }

        return jsonResponse({ ok: true, sent_to: payload.to });
    } catch (e) {
        // Never leak the SMTP password in error messages — denomailer
        // sometimes embeds the auth header in connection errors. We
        // sanitise just in case.
        const raw = (e as Error)?.message || String(e);
        const safe = raw.replace(/[A-Za-z0-9+/=]{16,}/g, "[redacted]");
        console.error("send-decline-email failed:", safe);
        return jsonResponse({ error: safe }, 500);
    }
});
