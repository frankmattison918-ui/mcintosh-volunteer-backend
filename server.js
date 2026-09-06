// server.js
import express from 'express';
import cors from 'cors';
import { Resend } from 'resend';
import jwt from 'jsonwebtoken';
import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors()); // allows your Netlify frontend (a different domain) to call this API
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const APPROVER_EMAIL = 'frankmattison918@gmail.com';
const NOTIFICATION_EMAIL = 'frankmattison918@fcboe.org';
const WEEKS_AHEAD = 10;

// ---- Firebase Admin setup ----
// Get this JSON from: Firebase Console > Project settings > Service accounts > Generate new private key.
// Store the WHOLE downloaded file's contents as one environment variable (FIREBASE_SERVICE_ACCOUNT_JSON)
// on whatever platform hosts this server (Render, Railway, Fly.io, etc). Never commit the JSON file itself.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://mhs-voluteer-default-rtdb.firebaseio.com'
});

const db = admin.database();
const boardRef = db.ref('volunteerHub/board');

// ---- Date helpers (mirrors the logic in the frontend) ----
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildOccurrences(startISO, recurring, count) {
  if (!recurring) return [{ date: startISO, volunteers: [] }];
  const occ = [];
  for (let i = 0; i < count; i++) {
    occ.push({ date: addDaysISO(startISO, i * 7), volunteers: [] });
  }
  return occ;
}

// Reads the current board, appends the new job, writes it back.
// Note: this is a simple read-modify-write, same approach the frontend uses.
// Fine for a school-scale site with occasional submissions; if you ever get
// truly simultaneous approvals, a keyed structure (jobs/{id}) with a plain
// push() would remove the last-write-wins risk entirely.
async function appendJobToBoard(data) {
  const spotsNeeded = parseInt(data.spots, 10) || 1;
  const newJob = {
    id: 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    orgName: data.orgName || '',
    contactName: data.name || '',
    requesterEmail: data.email,
    title: data.title || '',
    desc: data.desc || data.details || '',
    timeNote: data.timeNote || '',
    recurring: !!data.recurring,
    spotsNeeded,
    occurrences: buildOccurrences(data.date, !!data.recurring, WEEKS_AHEAD)
  };

  const snapshot = await boardRef.once('value');
  const currentJobs = snapshot.exists() ? (snapshot.val().jobs || []) : [];
  currentJobs.push(newJob);
  await boardRef.set({ jobs: currentJobs });
  return newJob;
}

// Mock database to hold pending requests (fine for now; swap for a real DB/table if you need it to survive restarts)
const pendingRequests = new Map();

// Endpoint called by your frontend form
app.post('/api/volunteer-request', async (req, res) => {
  const { name, email, details, orgName, title, desc, recurring, date, timeNote, spots } = req.body;

  if (!email || !date) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const requestId = Date.now().toString();
  const isInternal = email.trim().toLowerCase().endsWith('@fcboe.org');

  if (isInternal) {
    try {
      await appendJobToBoard({ orgName, name, email, title, desc, details, recurring, date, timeNote, spots });
      return res.json({ status: 'APPROVED', message: 'Volunteer request posted to the board!' });
    } catch (err) {
      console.error('Failed to post approved job to board:', err);
      return res.status(500).json({ error: 'Approved, but failed to post to the volunteer board.' });
    }
  }

  // Store full request details temporarily so we have everything needed to build the job later
  pendingRequests.set(requestId, {
    name, email, details, orgName, title, desc, recurring, date, timeNote, spots, status: 'PENDING'
  });

  // Generate a secure token valid for 7 days for the approval link
  const token = jwt.sign({ requestId }, JWT_SECRET, { expiresIn: '7d' });
  const approvalLink = `${process.env.BACKEND_URL || 'https://your-backend-domain.com'}/approve?token=${token}`;

  try {
    await resend.emails.send({
      from: 'Volunteer Hub <onboarding@resend.dev>',
      to: [NOTIFICATION_EMAIL],
      subject: 'Volunteer Request Pending Approval',
      html: `
        <h2>New Volunteer Request</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Details:</strong> ${details}</p>
        <br/>
        <a href="${approvalLink}" style="background-color: #007bff; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">Review Request</a>
      `
    });

    res.json({ status: 'PENDING', message: 'Request submitted for approval.' });
  } catch (error) {
    console.error('Failed to send notification email:', error);
    res.status(500).json({ error: 'Failed to send notification email.' });
  }
});

// Approval Page Route
app.get('/approve', (req, res) => {
  const { token } = req.query;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const request = pendingRequests.get(decoded.requestId);

    if (!request) {
      return res.status(404).send('Request not found or already processed.');
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Approve Request</title></head>
      <body>
        <h2>Volunteer Request Approval</h2>
        <p><strong>Applicant:</strong> ${request.name} (${request.email})</p>
        <p><strong>Details:</strong> ${request.details}</p>

        <p>You must be signed in as <strong>${APPROVER_EMAIL}</strong> to approve this request.</p>

        <form action="/api/process-approval" method="POST">
          <input type="hidden" name="token" value="${token}" />
          <input type="email" name="userEmail" placeholder="Confirm your email" required />
          <button type="submit" name="action" value="approve">Approve & Post</button>
          <button type="submit" name="action" value="deny">Deny</button>
        </form>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(401).send('Invalid or expired approval token.');
  }
});

// Process the approval action securely
app.post('/api/process-approval', express.urlencoded({ extended: true }), async (req, res) => {
  const { token, userEmail, action } = req.body;

  if (userEmail.trim().toLowerCase() !== APPROVER_EMAIL) {
    return res.status(403).send('Access Denied: You are not authorized to approve this request.');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const request = pendingRequests.get(decoded.requestId);

    if (!request) {
      return res.status(404).send('Request not found.');
    }

    if (action === 'approve') {
      try {
        await appendJobToBoard(request);
        request.status = 'APPROVED';
        return res.send('Request approved and posted to the job board!');
      } catch (err) {
        console.error('Failed to post approved job to board:', err);
        return res.status(500).send('Approved, but failed to post to the job board.');
      }
    } else {
      request.status = 'DENIED';
      return res.send('Request has been denied.');
    }
  } catch (err) {
    res.status(401).send('Invalid token.');
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
