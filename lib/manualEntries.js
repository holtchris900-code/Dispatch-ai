// Lets a business owner add their OWN jobs and appointments from their
// account page -- e.g. a call they answered themselves, or a booking made
// in person -- so everything sits in one list alongside what the AI logs.
//
// - A manual job is saved exactly like one the AI took down (source
//   "added by you"), and goes to ServiceM8 too if they've connected it.
// - A manual appointment goes onto their Google Calendar when it's
//   connected (so "Change time" and "Cancel" keep the calendar in step), or
//   is saved just in Dispatch AI when it isn't. Either way it shows in
//   "Upcoming appointments". Customers are NOT messaged automatically --
//   the owner has usually already spoken to them.
//
// server.js wires these to POST /api/client-portal/:token/jobs/new and
// POST /api/client-portal/:token/appointments/new.

const MANUAL_SOURCE = 'added by you';

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function addManualJob({ clientRecord, body, db, pushJobToServiceM8IfConnected }) {
  const job = {
    customerName: clean(body.customerName, 120),
    customerPhone: clean(body.customerPhone, 40),
    customerEmail: clean(body.customerEmail, 160),
    customerAddress: clean(body.customerAddress, 300),
    jobDescription: clean(body.jobDescription, 2000),
    preferredTime: clean(body.preferredTime, 200),
  };
  if (!job.jobDescription && !job.customerName) {
    return { status: 400, body: { error: 'Add at least the customer name or what the job is.' } };
  }
  const saved = db.addJob({ clientId: clientRecord.id, source: MANUAL_SOURCE, ...job });
  pushJobToServiceM8IfConnected(clientRecord, job);
  return { status: 200, body: { job: saved } };
}

async function addManualAppointment({ clientRecord, body, db, googleCalendar, getAccessToken }) {
  const date = clean(body.date, 10);
  const startTime = clean(body.startTime, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
    return { status: 400, body: { error: 'Please choose a date and a start time.' } };
  }
  const customerName = clean(body.customerName, 120);
  if (!customerName) {
    return { status: 400, body: { error: "Please add the customer's name." } };
  }
  const durationMinutes = Math.min(Math.max(Number(body.durationMinutes) || Number(clientRecord.intake?.appointmentLengthMinutes) || 60, 15), 720);
  const timeZone = clientRecord.intake?.timeZone || 'Europe/London';
  const customerPhone = clean(body.customerPhone, 40);
  const customerEmail = clean(body.customerEmail, 160);
  const description = clean(body.description, 2000);

  const startAt = googleCalendar.toRfc3339(date, startTime, timeZone);
  const endAt = googleCalendar.addMinutesRfc3339(startAt, durationMinutes, timeZone);
  if (new Date(startAt).getTime() < Date.now() - 5 * 60000) {
    return { status: 400, body: { error: 'That time has already passed. Please pick a future date and time.' } };
  }

  let calendarEventId = null;
  const calendarConnected = googleCalendar.isConfigured() && clientRecord.googleRefreshToken;
  if (calendarConnected) {
    try {
      const companyName = clientRecord.intake?.companyName || 'your business';
      const result = await googleCalendar.createAppointment({
        getAccessToken,
        date,
        startTime,
        durationMinutes,
        timeZone,
        summary: `${customerName} -- ${description || 'Appointment'}`,
        description: [
          customerPhone ? `Phone: ${customerPhone}` : null,
          customerEmail ? `Email: ${customerEmail}` : null,
          description ? `Job: ${description}` : null,
          `Added by ${companyName} in Dispatch AI.`,
        ].filter(Boolean).join('\n'),
      });
      if (result.conflict) {
        return { status: 409, body: { error: 'Something is already in your calendar at that time. Please pick another time.' } };
      }
      calendarEventId = result.eventId;
    } catch (err) {
      return { status: 502, body: { error: "Couldn't reach your Google Calendar just now. Please try again in a moment." } };
    }
  }

  const appointment = db.addAppointment({
    clientId: clientRecord.id,
    customerName,
    customerPhone,
    customerEmail,
    startAt,
    endAt,
    timeZone,
    description,
    calendarEventId,
    source: MANUAL_SOURCE,
  });
  return { status: 200, body: { appointment, addedToCalendar: Boolean(calendarEventId) } };
}

// For appointments that aren't on Google Calendar (added while it wasn't
// connected): moving them only needs to update Dispatch AI's own record.
function rescheduleLocalAppointment({ appt, body, db, googleCalendar }) {
  const date = clean(body.date, 10);
  const startTime = clean(body.startTime, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
    return { status: 400, body: { error: 'A new date and time are both required.' } };
  }
  const durationMinutes = Number(body.durationMinutes) || Math.round((new Date(appt.endAt) - new Date(appt.startAt)) / 60000) || 60;
  const timeZone = appt.timeZone || 'Europe/London';
  const startAt = googleCalendar.toRfc3339(date, startTime, timeZone);
  const endAt = googleCalendar.addMinutesRfc3339(startAt, durationMinutes, timeZone);
  const updated = db.updateAppointment(appt.id, { startAt, endAt });
  return { status: 200, body: { appointment: updated } };
}

module.exports = { addManualJob, addManualAppointment, rescheduleLocalAppointment };
