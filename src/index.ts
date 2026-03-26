/**
 * Pro Finish Custom Carpentry — Booking & ConvoAI Webhook Worker
 * Handles appointment booking, ConvoAI tool webhooks, public booking API,
 * and infinite customer memory (D1 + Echo Shared Brain).
 * D1: profinish | Owner: Adam McLemore | Midland, TX
 */

const SHARED_BRAIN_URL = 'https://echo-shared-brain.bmcii1976.workers.dev';
const BRAIN_INSTANCE_ID = 'profinish-booking';

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENVIRONMENT: string;
  WORKER_VERSION: string;
  ADAM_PHONE: string;
  PROFINISH_PHONE: string;
  OWNER_EMAIL: string;
  TWILIO_SID: string;
  TWILIO_TOKEN: string;
  ELEVENLABS_API_KEY: string;
}

interface MemoryEntry {
  customer_phone: string;
  customer_name?: string;
  interaction_type: 'call' | 'booking' | 'inquiry' | 'review' | 'job_complete' | 'urgent_callback' | 'slot_check';
  content: Record<string, unknown>;
}

interface AppointmentRequest {
  customer_name: string;
  customer_phone: string;
  customer_email?: string;
  address: string;
  city?: string;
  description: string;
  service_type?: string;
  preferred_date?: string;
  preferred_time?: string;
  language?: string;
  source?: string;
  urgent?: boolean;
}

// ─── CORS Headers ────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Echo-API-Key',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── Main Router ─────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health
      if (path === '/health') {
        const memCount = await env.DB.prepare('SELECT COUNT(*) as cnt FROM customer_memory').first<{ cnt: number }>();
        const custCount = await env.DB.prepare('SELECT COUNT(*) as cnt FROM customers').first<{ cnt: number }>();
        const apptCount = await env.DB.prepare('SELECT COUNT(*) as cnt FROM appointments').first<{ cnt: number }>();
        return json({
          status: 'healthy',
          version: env.WORKER_VERSION,
          service: 'profinish-booking',
          timestamp: new Date().toISOString(),
          stats: {
            customers: custCount?.cnt ?? 0,
            appointments: apptCount?.cnt ?? 0,
            memory_entries: memCount?.cnt ?? 0,
          },
        });
      }

      // ─── Public Booking API (website form) ───────────────────────
      if (path === '/book' && request.method === 'POST') {
        return handleBookAppointment(request, env);
      }

      // ─── Get available time slots ────────────────────────────────
      if (path === '/slots' && request.method === 'GET') {
        return handleGetSlots(url, env);
      }

      // ─── List appointments (auth required) ───────────────────────
      if (path === '/appointments' && request.method === 'GET') {
        return handleListAppointments(url, env);
      }

      // ─── Update appointment status (auth required) ───────────────
      if (path.startsWith('/appointments/') && request.method === 'PUT') {
        return handleUpdateAppointment(request, path, env);
      }

      // ─── ConvoAI Webhook (tool call from AI agent) ───────────────
      if (path === '/convai/book' && request.method === 'POST') {
        return handleConvoAIBooking(request, env);
      }

      // ─── ConvoAI check availability ──────────────────────────────
      if (path === '/convai/check-slots' && request.method === 'POST') {
        return handleConvoAICheckSlots(request, env);
      }

      // ─── ConvoAI urgent callback ─────────────────────────────────
      if (path === '/convai/urgent' && request.method === 'POST') {
        return handleConvoAIUrgent(request, env);
      }

      // ─── ConvoAI Memory: store interaction ──────────────────────
      if (path === '/convai/memory' && request.method === 'POST') {
        return handleConvoAIMemoryStore(request, env);
      }

      // ─── ConvoAI Recall: retrieve customer history ──────────────
      if (path === '/convai/recall' && request.method === 'POST') {
        return handleConvoAIRecall(request, env);
      }

      // ─── Customer memory search (admin) ─────────────────────────
      if (path === '/memory/search' && request.method === 'GET') {
        return handleMemorySearch(url, env);
      }

      // ─── Widget embed config ─────────────────────────────────────
      if (path === '/widget-config') {
        return json({
          agent_id: 'agent_1101kkhn2wv0e1raj8zcvs0w83ry',
          phone: '+14322192586',
          phone_display: '(432) 219-2586',
          business: 'Pro Finish Custom Carpentry',
          owner: 'Adam McLemore',
        });
      }

      // ─── Settings (AI Agent configuration) ─────────────────────────
      if (path === '/settings' && request.method === 'GET') {
        return handleGetSettings(env);
      }
      if (path === '/settings' && request.method === 'POST') {
        return handleSaveSettings(request, env);
      }
      if (path === '/settings/agent' && request.method === 'GET') {
        return handleGetAgentConfig(env);
      }
      if (path === '/settings/agent' && request.method === 'POST') {
        return handleUpdateAgent(request, env);
      }
      if (path === '/settings/test-call' && request.method === 'POST') {
        return handleTestCall(request, env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err: any) {
      console.error(JSON.stringify({ level: 'error', path, error: err.message, stack: err.stack }));
      return json({ error: 'Internal server error' }, 500);
    }
  },
};

// ─── Book Appointment (public API from website form) ─────────────────
async function handleBookAppointment(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as AppointmentRequest;

  if (!body.customer_name || !body.customer_phone || !body.address || !body.description) {
    return json({ error: 'Missing required fields: customer_name, customer_phone, address, description' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Determine date/time — if not specified, find next available slot
  let date = body.preferred_date || '';
  let timeStart = body.preferred_time || '';
  let timeEnd = '';

  if (!date || !timeStart) {
    const slot = await findNextAvailableSlot(env);
    date = date || slot.date;
    timeStart = timeStart || slot.time_start;
  }
  timeEnd = calculateEndTime(timeStart, 60); // 1-hour estimate visit

  // First check if customer exists, create if not
  let customerId = '';
  const existingCustomer = await env.DB.prepare(
    'SELECT id FROM customers WHERE phone = ? OR email = ? LIMIT 1'
  ).bind(body.customer_phone, body.customer_email || '').first();

  if (existingCustomer) {
    customerId = existingCustomer.id as string;
  } else {
    customerId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO customers (id, name, email, phone, address, preferred_language, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      customerId,
      body.customer_name,
      body.customer_email || '',
      body.customer_phone,
      body.address,
      body.language === 'es' ? 'es' : 'en',
      now
    ).run();
  }

  // Create the appointment
  await env.DB.prepare(
    `INSERT INTO appointments (id, customer_id, job_id, title, description, service_type, date, time_start, time_end, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    customerId,
    '',
    `Estimate: ${body.service_type || 'Custom Carpentry'}`,
    body.description,
    body.service_type || 'estimate',
    date,
    timeStart,
    timeEnd,
    body.urgent ? 'urgent' : 'scheduled',
    now
  ).run();

  // Send SMS notification to Adam
  if (env.TWILIO_SID && env.TWILIO_TOKEN) {
    const smsBody = body.urgent
      ? `🚨 URGENT: ${body.customer_name} needs a callback ASAP!\n${body.description}\nPhone: ${body.customer_phone}\nAddress: ${body.address}`
      : `📅 New estimate booked!\n${body.customer_name}\n${date} at ${timeStart}\n${body.description}\nPhone: ${body.customer_phone}\nAddress: ${body.address}`;

    await sendSMS(env, env.ADAM_PHONE, smsBody);
  }

  // ── Store to customer_memory ──
  await storeMemory(env, {
    customer_phone: body.customer_phone,
    customer_name: body.customer_name,
    interaction_type: 'booking',
    content: {
      appointment_id: id,
      date,
      time_start: timeStart,
      time_end: timeEnd,
      address: body.address,
      description: body.description,
      service_type: body.service_type || 'estimate',
      source: body.source || 'website',
      language: body.language,
      urgent: body.urgent || false,
    },
  });

  return json({
    success: true,
    appointment_id: id,
    date,
    time_start: timeStart,
    time_end: timeEnd,
    message: `Appointment scheduled for ${date} at ${timeStart}. Adam will be at ${body.address} to provide a free estimate.`,
  });
}

// ─── Get Available Slots ─────────────────────────────────────────────
async function handleGetSlots(url: URL, env: Env): Promise<Response> {
  const daysAhead = parseInt(url.searchParams.get('days') || '14');
  const slots = await getAvailableSlots(env, daysAhead);
  return json({ slots });
}

// ─── List Appointments (owner view) ──────────────────────────────────
async function handleListAppointments(url: URL, env: Env): Promise<Response> {
  const status = url.searchParams.get('status') || '';
  const limit = parseInt(url.searchParams.get('limit') || '50');

  let query = `SELECT a.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
    FROM appointments a LEFT JOIN customers c ON a.customer_id = c.id`;
  const params: string[] = [];

  if (status) {
    query += ' WHERE a.status = ?';
    params.push(status);
  }
  query += ' ORDER BY a.date ASC, a.time_start ASC LIMIT ?';
  params.push(String(limit));

  const stmt = env.DB.prepare(query);
  const result = await (params.length === 1
    ? stmt.bind(params[0])
    : params.length === 2
    ? stmt.bind(params[0], params[1])
    : stmt
  ).all();

  return json({ appointments: result.results, total: result.results.length });
}

// ─── Update Appointment ──────────────────────────────────────────────
async function handleUpdateAppointment(request: Request, path: string, env: Env): Promise<Response> {
  const id = path.split('/').pop();
  const body = await request.json() as { status?: string; date?: string; time_start?: string; time_end?: string; notes?: string };

  const updates: string[] = [];
  const values: string[] = [];

  if (body.status) { updates.push('status = ?'); values.push(body.status); }
  if (body.date) { updates.push('date = ?'); values.push(body.date); }
  if (body.time_start) { updates.push('time_start = ?'); values.push(body.time_start); }
  if (body.time_end) { updates.push('time_end = ?'); values.push(body.time_end); }

  if (updates.length === 0) return json({ error: 'No fields to update' }, 400);

  values.push(id!);
  await env.DB.prepare(`UPDATE appointments SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();

  return json({ success: true, id });
}

// ─── ConvoAI Tool: Book Appointment ──────────────────────────────────
async function handleConvoAIBooking(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    customer_name?: string;
    customer_phone?: string;
    address?: string;
    description?: string;
    service_type?: string;
    preferred_date?: string;
    preferred_time?: string;
    language?: string;
    urgent?: boolean;
  };

  console.log(JSON.stringify({ level: 'info', component: 'convai', action: 'book', body }));

  // The ConvoAI agent sends collected info via tool call
  const bookingRequest: AppointmentRequest = {
    customer_name: body.customer_name || 'Phone Caller',
    customer_phone: body.customer_phone || '',
    address: body.address || '',
    description: body.description || 'Estimate requested via phone',
    service_type: body.service_type || 'estimate',
    preferred_date: body.preferred_date,
    preferred_time: body.preferred_time,
    language: body.language,
    source: 'convai_phone',
    urgent: body.urgent,
  };

  // Create a fake Request to reuse the booking handler
  const fakeReq = new Request('https://fake/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingRequest),
  });

  return handleBookAppointment(fakeReq, env);
}

// ─── ConvoAI Tool: Check Available Slots ─────────────────────────────
async function handleConvoAICheckSlots(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { preferred_date?: string; customer_phone?: string; customer_name?: string };
  const slots = await getAvailableSlots(env, 14);

  // Store this slot-check interaction if we have a phone number
  if (body.customer_phone) {
    await storeMemory(env, {
      customer_phone: body.customer_phone,
      customer_name: body.customer_name,
      interaction_type: 'slot_check',
      content: {
        preferred_date: body.preferred_date || null,
        slots_available: slots.length,
        source: 'convai_phone',
      },
    });
  }

  // If they have a preferred date, filter to that date
  if (body.preferred_date) {
    const filtered = slots.filter(s => s.date === body.preferred_date);
    if (filtered.length > 0) {
      return json({
        available: true,
        slots: filtered.slice(0, 5),
        message: `We have ${filtered.length} slots available on ${body.preferred_date}.`,
      });
    }
    return json({
      available: false,
      nearest_slots: slots.slice(0, 3),
      message: `That date is fully booked. The nearest available times are listed.`,
    });
  }

  return json({
    available: slots.length > 0,
    slots: slots.slice(0, 5),
    message: slots.length > 0
      ? `The next available time is ${slots[0].date} at ${slots[0].time_start}.`
      : 'No slots available in the next 2 weeks. Adam will call to schedule.',
  });
}

// ─── ConvoAI Tool: Urgent Callback ───────────────────────────────────
async function handleConvoAIUrgent(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    customer_name?: string;
    customer_phone?: string;
    issue?: string;
  };

  console.log(JSON.stringify({ level: 'warn', component: 'convai', action: 'urgent', body }));

  // Send urgent SMS to Adam
  if (env.TWILIO_SID && env.TWILIO_TOKEN) {
    const msg = `🚨 URGENT CALLBACK NEEDED\n${body.customer_name || 'Customer'}\nPhone: ${body.customer_phone || 'unknown'}\nIssue: ${body.issue || 'Not specified'}\n\nPlease call back within 30 minutes.`;
    await sendSMS(env, env.ADAM_PHONE, msg);
  }

  // Store urgent callback to memory
  if (body.customer_phone) {
    await storeMemory(env, {
      customer_phone: body.customer_phone,
      customer_name: body.customer_name,
      interaction_type: 'urgent_callback',
      content: {
        issue: body.issue || 'Not specified',
        source: 'convai_phone',
      },
    });
  }

  return json({
    success: true,
    message: 'Adam has been notified and will call back within 30 minutes.',
  });
}

// ─── ConvoAI Memory: Store Interaction ────────────────────────────────
async function handleConvoAIMemoryStore(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    customer_phone?: string;
    customer_name?: string;
    interaction_type?: string;
    appointment_booked?: Record<string, unknown>;
    topics_discussed?: string[];
    notes?: string;
    address?: string;
    service_interest?: string;
    language?: string;
    sentiment?: string;
    follow_up_needed?: boolean;
  };

  if (!body.customer_phone) {
    return json({ error: 'customer_phone is required' }, 400);
  }

  console.log(JSON.stringify({ level: 'info', component: 'memory', action: 'store', phone: body.customer_phone }));

  const entry: MemoryEntry = {
    customer_phone: normalizePhone(body.customer_phone),
    customer_name: body.customer_name,
    interaction_type: (body.interaction_type as MemoryEntry['interaction_type']) || 'call',
    content: {
      appointment_booked: body.appointment_booked || null,
      topics_discussed: body.topics_discussed || [],
      notes: body.notes || '',
      address: body.address || '',
      service_interest: body.service_interest || '',
      language: body.language || 'en',
      sentiment: body.sentiment || 'neutral',
      follow_up_needed: body.follow_up_needed || false,
    },
  };

  try {
    await storeMemory(env, entry);

    // Also update/create customer record if we have a name
    if (body.customer_name) {
      const existing = await env.DB.prepare('SELECT id FROM customers WHERE phone = ? LIMIT 1')
        .bind(entry.customer_phone).first();
      if (existing) {
        await env.DB.prepare('UPDATE customers SET name = ? WHERE id = ?')
          .bind(body.customer_name, existing.id).run();
      } else {
        await env.DB.prepare(
          'INSERT INTO customers (id, name, phone, address, preferred_language, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          crypto.randomUUID(),
          body.customer_name,
          entry.customer_phone,
          body.address || '',
          body.language || 'en',
          new Date().toISOString()
        ).run();
      }
    }

    return json({
      success: true,
      message: `Memory stored for ${body.customer_name || body.customer_phone}`,
    });
  } catch (err: any) {
    console.error(JSON.stringify({ level: 'error', component: 'memory_handler', error: err.message, stack: err.stack }));
    return json({ error: 'Failed to store memory', detail: err.message }, 500);
  }
}

// ─── ConvoAI Recall: Retrieve Customer History ───────────────────────
async function handleConvoAIRecall(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { customer_phone?: string; customer_name?: string; limit?: number };

  if (!body.customer_phone && !body.customer_name) {
    return json({ error: 'customer_phone or customer_name is required' }, 400);
  }

  const phone = body.customer_phone ? normalizePhone(body.customer_phone) : '';
  const maxResults = body.limit || 20;

  console.log(JSON.stringify({ level: 'info', component: 'memory', action: 'recall', phone, name: body.customer_name }));

  // 1. Search customer_memory table
  let memories: any[] = [];
  if (phone) {
    const result = await env.DB.prepare(
      'SELECT * FROM customer_memory WHERE customer_phone = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(phone, maxResults).all();
    memories = result.results;
  } else if (body.customer_name) {
    const result = await env.DB.prepare(
      'SELECT * FROM customer_memory WHERE customer_name LIKE ? ORDER BY created_at DESC LIMIT ?'
    ).bind(`%${body.customer_name}%`, maxResults).all();
    memories = result.results;
  }

  // 2. Get customer profile from customers table
  let customer: any = null;
  if (phone) {
    customer = await env.DB.prepare('SELECT * FROM customers WHERE phone = ? LIMIT 1').bind(phone).first();
  }

  // 3. Get their appointments
  let appointments: any[] = [];
  if (customer) {
    const apptResult = await env.DB.prepare(
      `SELECT a.*, c.name as customer_name, c.phone as customer_phone
       FROM appointments a JOIN customers c ON a.customer_id = c.id
       WHERE c.phone = ? ORDER BY a.date DESC LIMIT ?`
    ).bind(phone, 10).all();
    appointments = apptResult.results;
  }

  // Parse content JSON blobs in memories
  const parsedMemories = memories.map((m: any) => ({
    ...m,
    content: typeof m.content === 'string' ? JSON.parse(m.content) : m.content,
  }));

  // Build a summary for the AI agent
  const interactionCount = parsedMemories.length;
  const lastInteraction = parsedMemories.length > 0 ? parsedMemories[0].created_at : null;
  const allTopics = parsedMemories.flatMap((m: any) => m.content?.topics_discussed || []);
  const uniqueTopics = [...new Set(allTopics)];
  const names = [...new Set(parsedMemories.map((m: any) => m.customer_name).filter(Boolean))];

  return json({
    found: interactionCount > 0 || customer !== null,
    customer: customer || null,
    summary: {
      total_interactions: interactionCount,
      last_interaction: lastInteraction,
      known_names: names,
      topics_discussed: uniqueTopics,
      total_appointments: appointments.length,
      is_returning_customer: interactionCount > 0,
    },
    memories: parsedMemories,
    appointments,
  });
}

// ─── Admin: Search Customer Memory ───────────────────────────────────
async function handleMemorySearch(url: URL, env: Env): Promise<Response> {
  const phone = url.searchParams.get('phone') || '';
  const name = url.searchParams.get('name') || '';
  const type = url.searchParams.get('type') || '';
  const limit = parseInt(url.searchParams.get('limit') || '50');

  let query = 'SELECT * FROM customer_memory WHERE 1=1';
  const params: string[] = [];

  if (phone) {
    query += ' AND customer_phone = ?';
    params.push(normalizePhone(phone));
  }
  if (name) {
    query += ' AND customer_name LIKE ?';
    params.push(`%${name}%`);
  }
  if (type) {
    query += ' AND interaction_type = ?';
    params.push(type);
  }
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(String(limit));

  const stmt = env.DB.prepare(query);
  let result;
  switch (params.length) {
    case 1: result = await stmt.bind(params[0]).all(); break;
    case 2: result = await stmt.bind(params[0], params[1]).all(); break;
    case 3: result = await stmt.bind(params[0], params[1], params[2]).all(); break;
    case 4: result = await stmt.bind(params[0], params[1], params[2], params[3]).all(); break;
    default: result = await stmt.all(); break;
  }

  const parsed = result.results.map((m: any) => ({
    ...m,
    content: typeof m.content === 'string' ? JSON.parse(m.content) : m.content,
  }));

  return json({ results: parsed, total: parsed.length });
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function getAvailableSlots(env: Env, daysAhead: number): Promise<Array<{ date: string; time_start: string; time_end: string; day_name: string }>> {
  const slots: Array<{ date: string; time_start: string; time_end: string; day_name: string }> = [];
  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Business hours: Mon-Fri 8am-5pm, Sat 9am-1pm
  const timeSlots: Record<number, string[]> = {
    1: ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'], // Mon
    2: ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'], // Tue
    3: ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'], // Wed
    4: ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'], // Thu
    5: ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'], // Fri
    6: ['09:00', '10:00', '11:00', '12:00'], // Sat
  };

  // Get existing appointments
  const startDate = now.toISOString().split('T')[0];
  const endDate = new Date(now.getTime() + daysAhead * 86400000).toISOString().split('T')[0];
  const existing = await env.DB.prepare(
    `SELECT date, time_start FROM appointments WHERE date >= ? AND date <= ? AND status != 'cancelled'`
  ).bind(startDate, endDate).all();

  const booked = new Set(existing.results.map((r: any) => `${r.date}_${r.time_start}`));

  for (let d = 1; d <= daysAhead; d++) {
    const date = new Date(now.getTime() + d * 86400000);
    const dow = date.getDay();
    const dateStr = date.toISOString().split('T')[0];
    const daySlots = timeSlots[dow];

    if (!daySlots) continue; // Sunday

    for (const time of daySlots) {
      if (!booked.has(`${dateStr}_${time}`)) {
        slots.push({
          date: dateStr,
          time_start: time,
          time_end: calculateEndTime(time, 60),
          day_name: dayNames[dow],
        });
      }
    }
  }

  return slots;
}

async function findNextAvailableSlot(env: Env): Promise<{ date: string; time_start: string }> {
  const slots = await getAvailableSlots(env, 14);
  if (slots.length > 0) return { date: slots[0].date, time_start: slots[0].time_start };
  // Fallback: next Monday at 9am
  const now = new Date();
  const daysUntilMon = ((1 - now.getDay()) + 7) % 7 || 7;
  const nextMon = new Date(now.getTime() + daysUntilMon * 86400000);
  return { date: nextMon.toISOString().split('T')[0], time_start: '09:00' };
}

function calculateEndTime(start: string, durationMin: number): string {
  const [h, m] = start.split(':').map(Number);
  const totalMin = h * 60 + m + durationMin;
  return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
}

async function sendSMS(env: Env, to: string, body: string): Promise<void> {
  try {
    const auth = btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`);
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: env.PROFINISH_PHONE,
        Body: body,
      }),
    });
    console.log(JSON.stringify({ level: 'info', component: 'sms', to, body_length: body.length }));
  } catch (err: any) {
    console.error(JSON.stringify({ level: 'error', component: 'sms', error: err.message }));
  }
}

// ─── Core Memory Functions ───────────────────────────────────────────

function normalizePhone(phone: string): string {
  // Strip everything except digits, then ensure +1 prefix
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${digits}`;
}

async function storeMemory(env: Env, entry: MemoryEntry): Promise<void> {
  const phone = normalizePhone(entry.customer_phone);
  const contentJson = JSON.stringify(entry.content);

  try {
    // 1. Store in D1 customer_memory table
    await env.DB.prepare(
      'INSERT INTO customer_memory (customer_phone, customer_name, interaction_type, content) VALUES (?, ?, ?, ?)'
    ).bind(phone, entry.customer_name || '', entry.interaction_type, contentJson).run();

    console.log(JSON.stringify({
      level: 'info',
      component: 'memory',
      action: 'stored',
      phone,
      type: entry.interaction_type,
    }));

    // 2. Ingest to Echo Shared Brain for cross-system memory (fire-and-forget)
    ingestToSharedBrain(
      `ProFinish ${entry.interaction_type}: ${entry.customer_name || phone} — ${summarizeContent(entry)}`,
      ['profinish', 'customer', entry.interaction_type]
    ).catch((err: any) => {
      console.error(JSON.stringify({ level: 'warn', component: 'shared_brain', error: err.message }));
    });
  } catch (err: any) {
    console.error(JSON.stringify({ level: 'error', component: 'memory', action: 'store_failed', error: err.message }));
  }
}

function summarizeContent(entry: MemoryEntry): string {
  const c = entry.content;
  const parts: string[] = [];
  if (c.description) parts.push(String(c.description));
  if (c.service_type) parts.push(`service: ${c.service_type}`);
  if (c.address) parts.push(`at ${c.address}`);
  if (c.date) parts.push(`date: ${c.date}`);
  if (c.issue) parts.push(`issue: ${c.issue}`);
  if (c.topics_discussed && Array.isArray(c.topics_discussed) && c.topics_discussed.length > 0) {
    parts.push(`topics: ${(c.topics_discussed as string[]).join(', ')}`);
  }
  if (c.notes) parts.push(`notes: ${c.notes}`);
  return parts.join(' | ') || entry.interaction_type;
}

async function ingestToSharedBrain(content: string, tags: string[]): Promise<void> {
  await fetch(`${SHARED_BRAIN_URL}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: BRAIN_INSTANCE_ID,
      role: 'assistant',
      content,
      importance: 6,
      tags,
    }),
  });
}

// ─── Settings Handlers ──────────────────────────────────────────────

const CONVAI_AGENT_ID = 'agent_1101kkhn2wv0e1raj8zcvs0w83ry';
const PHONE_NUMBER_ID = 'phnum_9301kkhn5s38e1ta538ae93b7pja';

async function handleGetSettings(env: Env): Promise<Response> {
  // Get settings from KV
  const raw = await env.CACHE.get('agent_settings', 'json') as Record<string, unknown> | null;
  const defaults = {
    greeting: 'Pro Finish Custom Carpentry, this is Adam. How can I help you today?',
    personality: 'friendly_texan',
    language: 'english_spanish',
    business_name: 'Pro Finish Custom Carpentry',
    owner_name: 'Adam McLemore',
    phone_display: '(432) 219-2586',
    service_area: 'Midland, Odessa, and surrounding Permian Basin',
    hours_weekday: '8:00 AM - 5:00 PM',
    hours_saturday: '9:00 AM - 1:00 PM',
    hours_sunday: 'Closed',
    voice_id: 'raufF5ywygfXTaFj9LAa',
    llm_model: 'claude-haiku-4-5',
    temperature: 0.6,
    max_response_length: 200,
    carpentry_expertise: true,
    date_awareness: true,
    auto_booking: true,
    sms_notifications: true,
    spanish_support: true,
    services: [
      'Custom Cabinetry', 'Trim & Molding', 'Door Installation',
      'Stair & Railing Work', 'Wainscoting & Wall Treatments',
      'Custom Closets & Storage', 'Mantel & Fireplace Surrounds',
      'Custom Furniture & Shelving', 'Exterior Trim & Fascia',
      'Finish Repair & Restoration', 'Commercial Finish Work',
    ],
  };
  return json({ ...defaults, ...raw });
}

async function handleSaveSettings(request: Request, env: Env): Promise<Response> {
  const settings = await request.json() as Record<string, unknown>;

  // Save to KV
  await env.CACHE.put('agent_settings', JSON.stringify(settings));

  // If greeting or personality changed, update ConvoAI agent
  if (settings.greeting || settings.temperature || settings.max_response_length) {
    try {
      await syncSettingsToAgent(settings, env);
    } catch (err: any) {
      console.error(JSON.stringify({ level: 'warn', msg: 'Failed to sync to ConvoAI', error: err.message }));
    }
  }

  return json({ success: true, message: 'Settings saved' });
}

async function handleGetAgentConfig(env: Env): Promise<Response> {
  const resp = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${CONVAI_AGENT_ID}`, {
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
  });
  if (!resp.ok) {
    return json({ error: 'Failed to fetch agent config', status: resp.status }, 500);
  }
  const agent = await resp.json() as Record<string, unknown>;
  const config = agent.conversation_config as Record<string, unknown> || {};
  const agentConfig = config.agent as Record<string, unknown> || {};
  const prompt = agentConfig.prompt as Record<string, unknown> || {};

  return json({
    agent_id: CONVAI_AGENT_ID,
    name: (agent as any).name,
    first_message: agentConfig.first_message,
    llm: prompt.llm,
    temperature: prompt.temperature,
    max_tokens: prompt.max_tokens,
    prompt_length: ((prompt.prompt as string) || '').length,
    voice_id: ((config.tts as Record<string, unknown>) || {}).voice_id,
  });
}

async function handleUpdateAgent(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const patchBody: Record<string, unknown> = { conversation_config: { agent: {} } };
  const agentPatch = (patchBody.conversation_config as any).agent;

  if (body.first_message) {
    agentPatch.first_message = body.first_message;
  }
  if (body.temperature !== undefined || body.max_tokens !== undefined || body.llm) {
    agentPatch.prompt = {};
    if (body.temperature !== undefined) agentPatch.prompt.temperature = Number(body.temperature);
    if (body.max_tokens !== undefined) agentPatch.prompt.max_tokens = Number(body.max_tokens);
    if (body.llm) agentPatch.prompt.llm = body.llm;
  }

  const resp = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${CONVAI_AGENT_ID}`, {
    method: 'PATCH',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patchBody),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return json({ error: 'Failed to update agent', details: errText }, 500);
  }

  return json({ success: true, message: 'Agent updated' });
}

async function handleTestCall(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { phone: string };
  if (!body.phone) {
    return json({ error: 'phone required' }, 400);
  }

  const callResp = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      agent_id: CONVAI_AGENT_ID,
      agent_phone_number_id: PHONE_NUMBER_ID,
      to_number: body.phone,
    }),
  });

  if (!callResp.ok) {
    const errText = await callResp.text();
    return json({ error: 'Failed to initiate call', details: errText }, 500);
  }

  const callData = await callResp.json();
  return json({ success: true, message: `Test call initiated to ${body.phone}`, data: callData });
}

async function syncSettingsToAgent(settings: Record<string, unknown>, env: Env): Promise<void> {
  const patchBody: Record<string, unknown> = { conversation_config: { agent: {} } };
  const agentPatch = (patchBody.conversation_config as any).agent;

  if (settings.greeting) {
    agentPatch.first_message = settings.greeting;
  }
  if (settings.temperature !== undefined || settings.max_response_length !== undefined) {
    agentPatch.prompt = {};
    if (settings.temperature !== undefined) agentPatch.prompt.temperature = Number(settings.temperature);
    if (settings.max_response_length !== undefined) agentPatch.prompt.max_tokens = Number(settings.max_response_length);
  }

  await fetch(`https://api.elevenlabs.io/v1/convai/agents/${CONVAI_AGENT_ID}`, {
    method: 'PATCH',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patchBody),
  });
}
