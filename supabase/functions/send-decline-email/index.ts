/**
 * HealthIQ — send-decline-email Edge Function
 * ============================================================
 * NOTE on the name: this function originally only handled
 * decline emails (hence the URL slug `send-decline-email`).
 * Since v1.6.22 it handles BOTH `declined` and `approved` order
 * outcomes, dispatched by a required `type` field in the body.
 * The deployment slug is kept stable for backwards compatibility
 * with already-deployed clients; if you ever want to rename it,
 * deploy a new function and run `supabase functions delete
 * send-decline-email` to remove this one.
 *
 * RUNTIME: Supabase Edge Functions / Deno 1.40+
 * The `@ts-nocheck` below tells your local VS Code TS engine
 * not to flag the remote URL imports + Deno globals — those
 * resolve fine inside Supabase's Deno runtime on deploy.
 *
 * SECURITY MODEL
 * ──────────────
 * 1. Caller MUST be admin. We verify via the dual check that
 *    mirrors the client (profiles.role==='admin' OR email is the
 *    bootstrap admin). On 403 we return a `debug` field so future
 *    "why am I locked out" issues are diagnosable in one shot.
 *
 * 2. Secrets: GMAIL_USER + GMAIL_APP_PASSWORD live in Supabase
 *    Edge Function Secrets — encrypted at rest, never in code,
 *    never in git, never returned in responses or logs (we even
 *    redact long base64-looking blobs from error messages so the
 *    password can't leak if nodemailer surfaces it in an
 *    exception).
 *
 * 3. Input validation: required fields per type, free-text
 *    fields HTML-escaped before template interpolation.
 *
 * SMTP LIBRARY — v1.6.23 switched from denomailer → nodemailer
 * ────────────────────────────────────────────────────────────
 * denomailer@1.6.0 has a known bug talking to Gmail: Gmail
 * closes the SMTP socket without sending a TLS close_notify
 * frame, which Deno's TLS layer raises as a fatal error AFTER
 * the email has already been accepted. Symptom in production:
 *   "peer closed connection without sending TLS close_notify"
 *   + "BadResource: Bad resource ID" event-loop exceptions.
 * The fix is nodemailer via Deno's `npm:` specifier — it's the
 * battle-tested Node.js SMTP library, and Supabase Edge Functions
 * have first-class npm support, so this Just Works™ on Gmail.
 *
 * DEPLOY
 * ──────
 *   supabase secrets set GMAIL_USER=thehealthiqinfo@gmail.com \
 *                         GMAIL_APP_PASSWORD="<16-char-app-pwd>"
 *   supabase functions deploy send-decline-email --no-verify-jwt
 * ============================================================
 */
// @ts-nocheck — file targets Deno runtime; local TS engine isn't Deno-aware.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
// Nodemailer over Deno's npm: specifier. v6.9.x is the current stable
// line; it handles Gmail's TLS close quirk gracefully and gives us
// proper SMTP error codes (e.g. EAUTH for bad app password) so the
// admin sees a useful reason in the toast.
import nodemailer from "npm:nodemailer@^6.9.7";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAIL_FALLBACK = "thehealthiqinfo@gmail.com";
const DEFAULT_SITE = "https://healthiqinfo.github.io/HealthIQ";

// ─── Helpers ──────────────────────────────────────────────────
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

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

// ─── Payload shapes ───────────────────────────────────────────
type EmailType = "declined" | "approved";
interface Payload {
    type: EmailType;
    to: string;
    userName?: string;
    courseTitle: string;
    amount: number;
    reason?: string;       // required when type='declined'
    siteUrl?: string;
}

// ─── DECLINED template ────────────────────────────────────────
function buildDeclineHtml(p: Payload): string {
    const site = p.siteUrl || DEFAULT_SITE;
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
      <tr><td style="background:linear-gradient(90deg,#0f6fec,#6366f1,#8b5cf6);padding:20px 28px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:0.4px;">HealthIQ Academy</td></tr>
      <tr><td style="padding:32px 28px 8px;">
        <h1 style="margin:0;font-size:22px;font-weight:800;color:#0f172a;line-height:1.3;">Action needed on your payment</h1>
        <p style="margin:8px 0 0;font-size:14px;color:#64748b;">Hi ${esc(p.userName || "there")}, we couldn't verify your recent payment.</p>
      </td></tr>
      <tr><td style="padding:20px 28px 0;">
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:18px;">
          <div style="font-size:13px;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:0.6px;">⚠️ Payment Declined</div>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:12px;font-size:14px;color:#0f172a;">
            <tr><td style="padding:4px 0;width:90px;color:#64748b;">Course</td><td style="padding:4px 0;font-weight:600;">${esc(p.courseTitle)}</td></tr>
            <tr><td style="padding:4px 0;color:#64748b;">Amount</td><td style="padding:4px 0;font-weight:600;">${esc(formatINR(p.amount))}</td></tr>
            <tr><td style="padding:4px 0;color:#64748b;vertical-align:top;">Reason</td><td style="padding:4px 0;font-weight:600;color:#991b1b;">${esc(p.reason || "")}</td></tr>
          </table>
        </div>
      </td></tr>
      <tr><td style="padding:20px 28px 4px;">
        <h2 style="margin:0;font-size:15px;font-weight:700;color:#0f172a;">What to do next</h2>
        <ol style="margin:10px 0 0 18px;padding:0;font-size:14px;color:#334155;line-height:1.6;">
          <li><strong>Check your bank / UPI account.</strong> If the money was deducted, reply with a clear transaction screenshot (showing UTR / reference number).</li>
          <li><strong>If no money left your account,</strong> simply re-initiate the payment from the HealthIQ website — your previous request has been cleared so you can try again immediately.</li>
          <li><strong>Need help?</strong> Reply to this email and we'll personally assist you.</li>
        </ol>
      </td></tr>
      <tr><td style="padding:24px 28px 8px;" align="center">
        <a href="${esc(site)}" style="display:inline-block;background:#0f6fec;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:700;font-size:14px;">Open HealthIQ &amp; Try Again</a>
        <p style="margin:12px 0 0;font-size:12px;color:#64748b;">You'll also see this notification in your account when you log in.</p>
      </td></tr>
      <tr><td style="padding:24px 28px 28px;border-top:1px solid #e2e8f0;">
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

function buildDeclineText(p: Payload): string {
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
        `Reason : ${p.reason || ""}`,
        `────────────────────────────`,
        ``,
        `WHAT TO DO NEXT`,
        `1. Check your bank/UPI. If money was deducted, reply with a`,
        `   screenshot showing UTR/reference number.`,
        `2. If no money left your account, re-initiate the payment from`,
        `   the HealthIQ website — your previous request has been cleared.`,
        `3. Need help? Just reply to this email.`,
        ``,
        `Open HealthIQ: ${p.siteUrl || DEFAULT_SITE}`,
        ``,
        `Warm regards,`,
        `The HealthIQ Team`,
    ].join("\r\n");
}

// ─── APPROVED template ────────────────────────────────────────
// Built with the SAME bulletproof rules as the decline template:
//   • 100%-table layout (no flexbox, no grid — both break in Outlook).
//   • Inline styles only (no <style> block — Gmail strips many of them).
//   • SOLID background colors on buttons (linear-gradient renders as
//     transparent in Outlook → naked text floating in space, which is
//     why the user reported a "junky" looking email in v1.6.23).
//   • NO `<!--[if mso]>` conditional comments or VML — Gmail's
//     parser sometimes leaks the raw markup into the rendered body.
//   • Cellpadding="0" cellspacing="0" border="0" on every table —
//     Outlook 2007+ ignores CSS box-sizing.
//   • Width="600" max-width:600px — the universally-safe email width.
//   • Plain-text fallback supplied via the multipart/alternative
//     `text` field; clients that strip HTML still get a usable note.
function buildApproveHtml(p: Payload): string {
    const site = p.siteUrl || DEFAULT_SITE;
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>HealthIQ — Welcome to ${esc(p.courseTitle)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f5f7fb;opacity:0;">Payment confirmed! Your access to "${esc(p.courseTitle)}" is now active. Open HealthIQ to start learning.</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f5f7fb;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(15,23,42,0.06);">
      <!-- Brand ribbon (solid green to match the approval mood) -->
      <tr><td style="background:#059669;padding:20px 28px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:0.4px;">HealthIQ Academy</td></tr>

      <!-- Hero — big celebratory header -->
      <tr><td style="padding:36px 28px 8px;text-align:center;">
        <div style="font-size:48px;line-height:1;margin-bottom:8px;">🎉</div>
        <h1 style="margin:0;font-size:24px;font-weight:800;color:#0f172a;line-height:1.3;">Payment Confirmed!</h1>
        <p style="margin:12px 0 0;font-size:15px;color:#475569;line-height:1.5;">Welcome aboard, ${esc(p.userName || "Learner")}. Your course access is now <strong style="color:#059669;">active</strong> and waiting for you.</p>
      </td></tr>

      <!-- Success card (green) -->
      <tr><td style="padding:24px 28px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;">
          <tr><td style="padding:18px;">
            <div style="font-size:13px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:0.6px;">✅ Access Granted</div>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:12px;font-size:14px;color:#0f172a;">
              <tr><td style="padding:4px 0;width:110px;color:#64748b;">Course</td><td style="padding:4px 0;font-weight:700;color:#065f46;">${esc(p.courseTitle)}</td></tr>
              <tr><td style="padding:4px 0;color:#64748b;">Amount paid</td><td style="padding:4px 0;font-weight:600;">${esc(formatINR(p.amount))}</td></tr>
              <tr><td style="padding:4px 0;color:#64748b;">Status</td><td style="padding:4px 0;font-weight:700;color:#059669;">Verified &amp; unlocked</td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>

      <!-- What you get (benefits grid) -->
      <tr><td style="padding:28px 28px 0;">
        <h2 style="margin:0 0 14px;font-size:15px;font-weight:700;color:#0f172a;">� What's included</h2>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td valign="top" width="33%" style="padding:0 8px 12px 0;">
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center;">
                <div style="font-size:24px;line-height:1;margin-bottom:6px;">📝</div>
                <div style="font-size:12px;font-weight:700;color:#0f172a;">High-yield notes</div>
                <div style="font-size:11px;color:#64748b;margin-top:3px;line-height:1.4;">Handwritten &amp; topper-curated</div>
              </div>
            </td>
            <td valign="top" width="34%" style="padding:0 4px 12px 4px;">
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center;">
                <div style="font-size:24px;line-height:1;margin-bottom:6px;">♾️</div>
                <div style="font-size:12px;font-weight:700;color:#0f172a;">Lifetime access</div>
                <div style="font-size:11px;color:#64748b;margin-top:3px;line-height:1.4;">Study at your own pace</div>
              </div>
            </td>
            <td valign="top" width="33%" style="padding:0 0 12px 8px;">
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center;">
                <div style="font-size:24px;line-height:1;margin-bottom:6px;">📱</div>
                <div style="font-size:12px;font-weight:700;color:#0f172a;">Any device</div>
                <div style="font-size:11px;color:#64748b;margin-top:3px;line-height:1.4;">Phone, tablet, laptop</div>
              </div>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- How to start -->
      <tr><td style="padding:20px 28px 8px;">
        <h2 style="margin:0 0 8px;font-size:15px;font-weight:700;color:#0f172a;">🚀 How to start in 30 seconds</h2>
        <ol style="margin:0 0 0 18px;padding:0;font-size:14px;color:#334155;line-height:1.7;">
          <li><strong>Log in</strong> using the same email you registered with.</li>
          <li>Click <strong>My Courses</strong> from your profile menu.</li>
          <li>Open <strong>${esc(p.courseTitle)}</strong> &mdash; start reading immediately.</li>
        </ol>
      </td></tr>

      <!-- BIG CTA — bulletproof table-button (no MSO conditionals, no gradients) -->
      <tr><td style="padding:28px 28px 12px;" align="center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
          <tr><td align="center" bgcolor="#059669" style="border-radius:10px;background:#059669;">
            <a href="${esc(site)}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:10px;">📚&nbsp;&nbsp;Start Learning Now</a>
          </td></tr>
        </table>
        <p style="margin:14px 0 0;font-size:12px;color:#64748b;">Or copy &amp; paste this link into your browser:<br/><a href="${esc(site)}" style="color:#0f6fec;text-decoration:none;word-break:break-all;">${esc(site)}</a></p>
      </td></tr>

      <!-- Trust badges row -->
      <tr><td style="padding:18px 28px 8px;" align="center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td style="padding:0 6px;">
              <span style="display:inline-block;background:#fef3c7;color:#92400e;padding:6px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.3px;">🏅 BHMS Gold Medalist</span>
            </td>
            <td style="padding:0 6px;">
              <span style="display:inline-block;background:#dbeafe;color:#1e40af;padding:6px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.3px;">👥 100+ Students</span>
            </td>
            <td style="padding:0 6px;">
              <span style="display:inline-block;background:#f3e8ff;color:#6b21a8;padding:6px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.3px;">🔒 Verified Pay</span>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Help strip -->
      <tr><td style="padding:20px 28px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;">
          <tr><td style="padding:14px 16px;font-size:13px;color:#1e3a8a;line-height:1.5;">
            <strong>💬 Need help?</strong> Just reply to this email — a real human reads every message and we usually get back within a few hours.
          </td></tr>
        </table>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:24px 28px 28px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-top:1px solid #e2e8f0;">
          <tr><td style="padding-top:18px;">
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
              This email confirms your payment was verified by an admin at HealthIQ Academy. If you didn't make this purchase, please reply to this email immediately so we can investigate.<br/><br/>
              © HealthIQ Academy &middot; <a href="${esc(site)}" style="color:#0f6fec;text-decoration:none;">${esc(site)}</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildApproveText(p: Payload): string {
    return [
        `Hi ${p.userName || "there"},`,
        ``,
        `🎉 Payment confirmed — welcome aboard!`,
        ``,
        `Your access to "${p.courseTitle}" is now active and waiting for you.`,
        ``,
        `────────────────────────────`,
        `Course      : ${p.courseTitle}`,
        `Amount paid : ${formatINR(p.amount)}`,
        `Status      : Verified & unlocked ✓`,
        `────────────────────────────`,
        ``,
        `WHAT'S INCLUDED`,
        `  📝 High-yield handwritten notes & topper-curated material`,
        `  ♾️  Lifetime access — study at your own pace`,
        `  📱 Works on phone, tablet, and laptop`,
        ``,
        `HOW TO START IN 30 SECONDS`,
        `  1. Log in using the same email you registered with.`,
        `  2. Click "My Courses" from your profile menu.`,
        `  3. Open "${p.courseTitle}" and start reading immediately.`,
        ``,
        `Start learning here:`,
        `  ${p.siteUrl || DEFAULT_SITE}`,
        ``,
        `💬 Need help? Just reply to this email — a real human reads`,
        `   every message and we usually get back within a few hours.`,
        ``,
        `🏅 Curated by a BHMS Gold Medalist`,
        `👥 Trusted by 100+ students`,
        ``,
        `Warm regards,`,
        `The HealthIQ Team`,
    ].join("\r\n");
}

// ─── Dispatch ─────────────────────────────────────────────────
function buildSubject(p: Payload): string {
    if (p.type === "approved") {
        return `🎉 Welcome to "${p.courseTitle}" — your HealthIQ access is now active`;
    }
    return `HealthIQ — Action needed on your payment for "${p.courseTitle}"`;
}

function buildHtml(p: Payload): string {
    return p.type === "approved" ? buildApproveHtml(p) : buildDeclineHtml(p);
}

function buildText(p: Payload): string {
    return p.type === "approved" ? buildApproveText(p) : buildDeclineText(p);
}

// ─── Main handler ─────────────────────────────────────────────
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
    }

    try {
        // 1. Caller-must-be-admin gate
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
            return jsonResponse({ error: "Missing Authorization header" }, 401);
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL");
        const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY");
        if (!supabaseUrl || !supabaseAnon) {
            return jsonResponse(
                { error: "Server misconfigured (missing SUPABASE_URL/ANON_KEY)" },
                500,
            );
        }

        const supabase = createClient(supabaseUrl, supabaseAnon, {
            global: { headers: { Authorization: authHeader } },
        });

        const { data: userData, error: userErr } = await supabase.auth.getUser();
        if (userErr || !userData?.user) {
            return jsonResponse({ error: "Invalid or expired session" }, 401);
        }

        // Dual admin check (mirrors client: profiles.role OR bootstrap email)
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
                            ? `Your profile has role='${profileRole}'. Run the SQL fix to set it to 'admin'.`
                            : "No profiles row found for your user. Run the SQL fix to create one with role='admin'.",
                    },
                },
                403,
            );
        }

        // 2. Validate payload
        let payload: Payload;
        try {
            payload = await req.json();
        } catch {
            return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        // Type defaults to 'declined' for backwards compatibility with clients
        // that haven't been redeployed yet (older v1.6.21).
        if (!payload.type) payload.type = "declined";
        if (payload.type !== "declined" && payload.type !== "approved") {
            return jsonResponse(
                { error: `Invalid type '${payload.type}' — must be 'declined' or 'approved'` },
                400,
            );
        }
        if (!payload.to || !payload.courseTitle) {
            return jsonResponse(
                { error: "Missing required fields: to, courseTitle" },
                400,
            );
        }
        if (payload.type === "declined" && !payload.reason) {
            return jsonResponse(
                { error: "Missing required field 'reason' for declined emails" },
                400,
            );
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.to)) {
            return jsonResponse({ error: "Invalid 'to' email address" }, 400);
        }

        // 3. Read SMTP secrets
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

        // 4. Send via Gmail SMTP using nodemailer (v1.6.23+).
        //    Notes on the config:
        //    - port 465 + secure:true = implicit TLS (Gmail's recommended config).
        //    - service:'gmail' would also work, but explicit host/port is more
        //      self-documenting and survives Gmail service-string rename quirks.
        //    - `pool:false` keeps it a fresh connection per send — we only send
        //      one email per invocation, no benefit to pooling, and it avoids
        //      lingering sockets between Edge Function cold starts.
        //    - `tls: { minVersion: 'TLSv1.2' }` is Gmail's minimum since 2024.
        const transporter = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: { user: gmailUser, pass: gmailPass },
            pool: false,
            tls: { minVersion: "TLSv1.2" },
            // Edge Functions cold-start fast; if SMTP hangs >15s something is
            // very wrong and we'd rather fail fast than burn function quota.
            connectionTimeout: 15000,
            greetingTimeout: 10000,
            socketTimeout: 20000,
        });

        try {
            const info = await transporter.sendMail({
                from: `HealthIQ Academy <${gmailUser}>`,
                to: payload.to,
                subject: buildSubject(payload),
                text: buildText(payload),
                html: buildHtml(payload),
            });
            console.log(
                `[send-decline-email] ${payload.type} → ${payload.to} | messageId=${info.messageId} | response=${info.response}`,
            );
        } finally {
            // Best-effort close — nodemailer handles Gmail's no-close_notify
            // gracefully, but we still call close() to release the socket
            // immediately rather than waiting for GC.
            try { transporter.close(); } catch (_) { /* socket already gone */ }
        }

        return jsonResponse({ ok: true, type: payload.type, sent_to: payload.to });
    } catch (e) {
        // Surface a useful error message back to the client. Nodemailer attaches
        // a `.code` (e.g. EAUTH, ECONNECTION, EENVELOPE) and `.responseCode`
        // (SMTP reply code like 535) which are way more actionable than the
        // raw message alone. We still redact long base64-looking blobs so the
        // app password can never leak into the response, even if Gmail echoes
        // it back in an error string.
        const err = e as { message?: string; code?: string; responseCode?: number; response?: string };
        const parts: string[] = [];
        if (err?.code) parts.push(err.code);
        if (err?.responseCode) parts.push(`SMTP ${err.responseCode}`);
        const baseMsg = err?.message || err?.response || String(e) || "Unknown SMTP error";
        const prefix = parts.length ? `[${parts.join(" / ")}] ` : "";
        const raw = `${prefix}${baseMsg}`;
        const safe = raw.replace(/[A-Za-z0-9+/=]{16,}/g, "[redacted]");
        console.error("send-decline-email failed:", safe);
        return jsonResponse({ error: safe, code: err?.code || null }, 500);
    }
});
