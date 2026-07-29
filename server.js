/**
 * BulkMailer Pro — Node.js Backend Server
 * Developer: Raja
 *
 * Handles real SMTP email sending via Nodemailer
 * Supports: Gmail App Pass, Gmail API, Yahoo, iCloud, MS365, AWS SES, SendGrid, Mailgun, Custom SMTP
 *
 * Setup:
 *   npm install
 *   node server.js
 *
 * For production (keeps running):
 *   npm install -g pm2
 *   pm2 start server.js --name bulkmailer
 */

const express    = require('express');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const app        = express();

// ── Config ───────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const MAX_BATCH  = 50;   // max emails per API request
const DELAY_MS   = 200;  // ms delay between each email (avoid rate limits)

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));          // Allow requests from your HTML dashboard
app.use(express.json({ limit: '50mb' }));// Support attachments (base64)

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'BulkMailer Pro Backend Running',
    developer: 'Raja',
    version: '2.0.0',
    time: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => res.json({ ok: true }));

// ── SMTP host presets ─────────────────────────────────────────────────────────
const SMTP_PRESETS = {
  gmail_app: { host: 'smtp.gmail.com',                       port: 587, secure: false },
  gmail_api: { host: 'smtp.gmail.com',                       port: 587, secure: false },
  gmail:     { host: 'smtp.gmail.com',                       port: 587, secure: false },
  yahoo:     { host: 'smtp.mail.yahoo.com',                  port: 587, secure: false },
  icloud:    { host: 'smtp.mail.me.com',                     port: 587, secure: false },
  ms365:     { host: 'smtp.office365.com',                   port: 587, secure: false },
  aws_ses:   { host: 'email-smtp.us-east-1.amazonaws.com',   port: 587, secure: false },
  sendgrid:  { host: 'smtp.sendgrid.net',                    port: 587, secure: false },
  mailgun:   { host: 'smtp.mailgun.org',                     port: 587, secure: false },
};

// Transporter cache — reuse connections for same credentials
const transporterCache = new Map();

function getTransporter(smtpConfig) {
  // Normalize — accept password, pass, or apiKey
  const rawPass = (smtpConfig.password || smtpConfig.pass || smtpConfig.apiKey || '').trim();
  // Gmail App Passwords have spaces — remove them so nodemailer gets clean 16-char string
  const cleanPass = smtpConfig.type === 'gmail_app' ? rawPass.replace(/\s+/g, '') : rawPass;

  const key = `${smtpConfig.email}:${smtpConfig.host}:${smtpConfig.port}:${cleanPass.slice(0,4)}`;
  if (transporterCache.has(key)) return transporterCache.get(key);

  const preset = SMTP_PRESETS[smtpConfig.type] || null;
  const host   = smtpConfig.host || preset?.host || 'smtp.gmail.com';
  const port   = parseInt(smtpConfig.port) || preset?.port || 587;
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: smtpConfig.email,
      pass: cleanPass,
    },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
  });

  transporterCache.set(key, transporter);
  setTimeout(() => transporterCache.delete(key), 600000);
  return transporter;
}

// ── Test SMTP connection ──────────────────────────────────────────────────────
app.post('/test', async (req, res) => {
  const { smtp } = req.body;
  if (!smtp?.email) {
    return res.status(400).json({ ok: false, error: 'Email required' });
  }
  // Normalize password field
  smtp.password = smtp.password || smtp.pass || smtp.apiKey || '';
  if (!smtp.password) {
    return res.status(400).json({ ok: false, error: 'Password / App Password is empty' });
  }
  try {
    const t = getTransporter(smtp);
    await t.verify();
    res.json({ ok: true, message: `Connected to ${smtp.host || 'SMTP server'} successfully!` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Main Send Endpoint ────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { emails } = req.body;

  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'No emails provided' });
  }
  if (emails.length > MAX_BATCH) {
    return res.status(400).json({ error: `Max ${MAX_BATCH} emails per request` });
  }

  const results = [];

  for (const item of emails) {
    const { smtp, to, name, subject, fromName, body, isHtml, attachments } = item;

    // Normalize password — accept password, pass, or apiKey
    if (smtp) {
      smtp.password = (smtp.password || smtp.pass || smtp.apiKey || '').trim();
      // Gmail App Password: remove spaces (e.g. "abcd efgh ijkl mnop" → "abcdefghijklmnop")
      if (smtp.type === 'gmail_app' || smtp.type === 'gmail') {
        smtp.password = smtp.password.replace(/\s+/g, '');
      }
    }

    // Validation with specific messages
    if (!smtp?.email) {
      results.push({ to: to || '?', ok: false, error: 'Sender email is missing — check SMTP Config tab', label: '?' });
      continue;
    }
    if (!to) {
      results.push({ to: '?', ok: false, error: 'Recipient email is missing', label: smtp?.label || smtp?.email });
      continue;
    }
    if (!smtp.password) {
      results.push({ to, ok: false, error: `Password empty for ${smtp.email} — open SMTP Config and re-enter App Password`, label: smtp?.label || smtp?.email });
      continue;
    }

    try {
      const transporter = getTransporter(smtp);

      // Build mail options
      const mailOptions = {
        from: fromName
          ? `"${fromName}" <${smtp.email}>`
          : smtp.email,
        to,
        subject,
        [isHtml ? 'html' : 'text']: body,
      };

      // Also add plain text fallback if sending HTML
      if (isHtml) {
        mailOptions.text = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      }

      // Process attachments
      if (Array.isArray(attachments) && attachments.length > 0) {
        mailOptions.attachments = attachments.map(a => ({
          filename: a.name,
          content:  Buffer.from(a.data, 'base64'),
          contentType: a.type || 'application/octet-stream',
        }));
      }

      const info = await transporter.sendMail(mailOptions);
      results.push({
        to,
        ok:        true,
        messageId: info.messageId,
        label:     smtp.label || smtp.email,
      });

      console.log(`✓ Sent → ${to} [${smtp.label || smtp.email}]`);

    } catch (err) {
      results.push({
        to,
        ok:    false,
        error: err.message,
        label: smtp?.label || smtp?.email || '?',
      });
      console.error(`✗ Failed → ${to}: ${err.message}`);
    }

    // Small delay between emails to avoid triggering rate limits
    await sleep(DELAY_MS);
  }

  const sent   = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`Batch done: ${sent} sent, ${failed} failed`);

  res.json({ ok: true, sent, failed, results });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║        BulkMailer Pro — Backend           ║');
  console.log('║        Developer: Raja                    ║');
  console.log('╠═══════════════════════════════════════════╣');
  console.log(`║  Server running at: http://localhost:${PORT}  ║`);
  console.log('║  Open BulkMailerPro.html in your browser  ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');
});
