// Builds the confirmation email a CUSTOMER gets the moment the AI books
// them in -- plain text plus a simple HTML version, so it looks like it
// came from a real business (who, when, what, where, how to reach them)
// rather than a bare one-line notice. Kept in its own file so it can be
// tested without the rest of server.js.

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// +441313670407 -> "0131 367 0407", +447597919776 -> "07597 919776".
// Anything it doesn't recognise is returned unchanged.
function formatUkPhone(number) {
  const raw = String(number || '').replace(/[\s()-]/g, '');
  let national = raw;
  if (raw.startsWith('+44')) national = '0' + raw.slice(3);
  if (!/^0\d{10}$/.test(national)) return String(number || '');
  if (national.startsWith('02')) return `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
  if (/^01\d1/.test(national) || /^011/.test(national)) return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
  return `${national.slice(0, 5)} ${national.slice(5)}`;
}

function buildBookingConfirmationEmail({ companyName, customerName, whenLabel, jobDescription, address, businessPhone, manageUrl }) {
  const company = companyName || 'the business';
  const phone = businessPhone ? formatUkPhone(businessPhone) : '';
  const greeting = customerName ? `Hi ${customerName},` : 'Hi,';

  const rows = [
    ['When', whenLabel],
    ['Job', jobDescription],
    ['Address', address],
    ['Contact', phone ? `${company} on ${phone}` : ''],
  ].filter(([, value]) => value);

  const subject = `Booking confirmed: ${company}, ${whenLabel}`;

  const text = [
    greeting,
    '',
    `You're booked in with ${company}.`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Need to cancel or change the time? Use this link:',
    manageUrl,
    '',
    phone ? `Any questions, call ${company} on ${phone} or just reply to this email.` : 'Any questions, just reply to this email.',
    '',
    `-- ${company}`,
  ].join('\n');

  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-size:14px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;color:#111827;font-size:15px;">${escapeHtml(value)}</td></tr>`
    )
    .join('');

  const phoneLink = phone
    ? `<a href="tel:${escapeHtml(String(businessPhone).replace(/\s/g, ''))}" style="color:#111827;white-space:nowrap;">${escapeHtml(phone)}</a>`
    : '';

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px 24px;">
<tr><td>
<p style="margin:0 0 4px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(company)}</p>
<h1 style="margin:0 0 16px;font-size:22px;color:#111827;">You're booked in</h1>
<p style="margin:0 0 16px;font-size:15px;color:#111827;">${escapeHtml(greeting)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">${rowsHtml}</table>
<a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:15px;">Change or cancel</a>
<p style="margin:20px 0 0;font-size:14px;color:#374151;">${phone ? `Any questions, call ${escapeHtml(company)} on ${phoneLink} or just reply to this email.` : 'Any questions, just reply to this email.'}</p>
</td></tr></table>
</td></tr></table></body></html>`;

  return { subject, text, html };
}

module.exports = { buildBookingConfirmationEmail, formatUkPhone };
