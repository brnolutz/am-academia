// ============================================================
// ACADEMIA AM SERVER — Zoho Brasil
// Serve frontend + API para o LMS
// ============================================================
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const AI_PROVIDER = ANTHROPIC_KEY ? 'anthropic' : OPENAI_KEY ? 'openai' : null;
const HTML_PATH = path.join(__dirname, 'academia.html');

function setCORS(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,apikey,Prefer');
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function sb(method, table, query, payload, options) {
  query = query || ''; options = options || {};
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL) { reject(new Error('Supabase not configured')); return; }
    const parsed = new URL(SUPABASE_URL);
    const data = payload ? JSON.stringify(payload) : undefined;
    const prefer = options.prefer || (method === 'POST' ? 'return=representation' : '');
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
    };
    if (prefer) headers['Prefer'] = prefer;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const opts = {
      hostname: parsed.hostname,
      path: '/rest/v1/' + table + (query ? '?' + query : ''),
      method, headers
    };
    const req = https.request(opts, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(out || '[]') }); }
        catch { resolve({ status: res.statusCode, data: out }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function callAI(payload) {
  if (AI_PROVIDER === 'anthropic') {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const opts = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
      };
      const req = https.request(opts, res => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, data: { error: out } }); } });
      });
      req.on('error', reject);
      req.write(data); req.end();
    });
  }
  // OpenAI
  return new Promise((resolve, reject) => {
    const messages = [];
    if (payload.system) messages.push({ role: 'system', content: payload.system });
    (payload.messages || []).forEach(m => messages.push(m));
    const body = JSON.stringify({ model: 'gpt-4o', max_tokens: payload.max_tokens || 2000, messages });
    const opts = {
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + OPENAI_KEY }
    };
    const req = https.request(opts, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(out);
          if (p.choices?.[0]?.message?.content) {
            resolve({ status: res.statusCode, data: { content: [{ type: 'text', text: p.choices[0].message.content }] } });
          } else resolve({ status: res.statusCode, data: p });
        } catch { resolve({ status: res.statusCode, data: { error: out } }); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const parts = parsed.pathname.split('/').filter(Boolean);

  const respond = (status, data, ct) => {
    res.setHeader('Content-Type', ct || 'application/json');
    res.writeHead(status);
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };

  // Frontend
  if (parts.length === 0 || parsed.pathname === '/') {
    if (fs.existsSync(HTML_PATH)) {
      respond(200, fs.readFileSync(HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
    } else {
      respond(200, '<h1>Academia AM API</h1><p><a href="/health">/health</a></p>', 'text/html');
    }
    return;
  }

  if (parsed.pathname === '/health') {
    return respond(200, { status: 'Academia AM v1', ai: AI_PROVIDER || 'none', db: SUPABASE_URL ? 'ok' : 'missing', ts: new Date().toISOString() });
  }

  if (parts[0] !== 'api') return respond(404, { error: 'not found' });

  res.setHeader('Content-Type', 'application/json');
  const resource = parts[1];
  const id = parts[2];
  const body = ['POST','PUT','PATCH'].includes(req.method) ? await readBody(req) : {};

  try {
    // AI
    if (resource === 'ai' && req.method === 'POST') {
      if (!AI_PROVIDER) return respond(500, { error: 'No AI key' });
      const r = await callAI(body);
      return respond(r.status, r.data);
    }

    // USERS (read only from Bridge)
    if (resource === 'users' && req.method === 'GET') {
      const r = await sb('GET', 'users', 'order=name');
      return respond(200, r.data || []);
    }

    // COURSES
    if (resource === 'courses') {
      if (req.method === 'GET' && !id) {
        const r = await sb('GET', 'courses', 'order=created_at.desc');
        return respond(200, r.data || []);
      }
      if (req.method === 'GET' && id) {
        const r = await sb('GET', 'courses', 'id=eq.' + id);
        return respond(200, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'POST') {
        body.updated_at = new Date().toISOString();
        const r = await sb('POST', 'courses', '', body);
        return respond(201, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'PUT' && id) {
        body.updated_at = new Date().toISOString();
        const r = await sb('PATCH', 'courses', 'id=eq.' + id, body, { prefer: 'return=representation' });
        return respond(200, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'DELETE' && id) {
        await sb('DELETE', 'am_lesson_progress', 'course_id=eq.' + id);
        await sb('DELETE', 'course_enrollments', 'course_id=eq.' + id);
        // Get lessons to delete quiz questions
        const lessons = await sb('GET', 'course_lessons', 'course_id=eq.' + id);
        for (const l of (lessons.data || [])) {
          await sb('DELETE', 'quiz_questions', 'lesson_id=eq.' + l.id);
        }
        await sb('DELETE', 'course_lessons', 'course_id=eq.' + id);
        await sb('DELETE', 'course_modules', 'course_id=eq.' + id);
        await sb('DELETE', 'courses', 'id=eq.' + id);
        return respond(200, { success: true });
      }
    }

    // MODULES
    if (resource === 'modules') {
      if (req.method === 'GET') {
        const q = parsed.query.course_id ? 'course_id=eq.' + parsed.query.course_id + '&order=ordem' : 'order=ordem';
        const r = await sb('GET', 'course_modules', q);
        return respond(200, r.data || []);
      }
      if (req.method === 'POST') {
        const r = await sb('POST', 'course_modules', '', body);
        return respond(201, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'PUT' && id) {
        const r = await sb('PATCH', 'course_modules', 'id=eq.' + id, body, { prefer: 'return=representation' });
        return respond(200, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'DELETE' && id) {
        await sb('DELETE', 'course_lessons', 'module_id=eq.' + id);
        await sb('DELETE', 'course_modules', 'id=eq.' + id);
        return respond(200, { success: true });
      }
    }

    // LESSONS
    if (resource === 'lessons') {
      if (req.method === 'GET') {
        const q = parsed.query.module_id ? 'module_id=eq.' + parsed.query.module_id + '&order=ordem'
          : parsed.query.course_id ? 'course_id=eq.' + parsed.query.course_id + '&order=ordem'
          : 'order=ordem';
        const r = await sb('GET', 'course_lessons', q);
        return respond(200, r.data || []);
      }
      if (req.method === 'GET' && id) {
        const r = await sb('GET', 'course_lessons', 'id=eq.' + id);
        return respond(200, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'POST') {
        const r = await sb('POST', 'course_lessons', '', body);
        return respond(201, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'PUT' && id) {
        const r = await sb('PATCH', 'course_lessons', 'id=eq.' + id, body, { prefer: 'return=representation' });
        return respond(200, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'DELETE' && id) {
        await sb('DELETE', 'quiz_questions', 'lesson_id=eq.' + id);
        await sb('DELETE', 'am_lesson_progress', 'lesson_id=eq.' + id);
        await sb('DELETE', 'course_lessons', 'id=eq.' + id);
        return respond(200, { success: true });
      }
    }

    // QUIZ QUESTIONS
    if (resource === 'questions') {
      if (req.method === 'GET') {
        const q = parsed.query.lesson_id ? 'lesson_id=eq.' + parsed.query.lesson_id + '&order=created_at' : 'order=created_at';
        const r = await sb('GET', 'quiz_questions', q);
        return respond(200, r.data || []);
      }
      if (req.method === 'POST') {
        // Can post array or single
        if (Array.isArray(body)) {
          const results = [];
          for (const q of body) {
            const r = await sb('POST', 'quiz_questions', '', q);
            results.push(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          return respond(201, results);
        }
        const r = await sb('POST', 'quiz_questions', '', body);
        return respond(201, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'DELETE' && id) {
        await sb('DELETE', 'quiz_questions', 'id=eq.' + id);
        return respond(200, { success: true });
      }
    }

    // PROGRESS
    if (resource === 'progress') {
      if (req.method === 'GET') {
        const q = parsed.query.am ? 'am_name=eq.' + parsed.query.am + '&order=created_at.desc'
          : parsed.query.course_id ? 'course_id=eq.' + parsed.query.course_id + '&order=am_name'
          : 'order=created_at.desc&limit=500';
        const r = await sb('GET', 'am_lesson_progress', q);
        return respond(200, r.data || []);
      }
      if (req.method === 'POST') {
        const r = await sb('POST', 'am_lesson_progress', 'on_conflict=am_name,lesson_id', body, { prefer: 'return=representation' });
        return respond(200, Array.isArray(r.data) ? r.data[0] : r.data);
      }
    }

    // ENROLLMENTS
    if (resource === 'enrollments') {
      if (req.method === 'GET') {
        const q = parsed.query.am ? 'am_name=eq.' + parsed.query.am + '&order=enrolled_at.desc'
          : parsed.query.course_id ? 'course_id=eq.' + parsed.query.course_id
          : 'order=enrolled_at.desc';
        const r = await sb('GET', 'course_enrollments', q);
        return respond(200, r.data || []);
      }
      if (req.method === 'POST') {
        const r = await sb('POST', 'course_enrollments', 'on_conflict=am_name,course_id', body, { prefer: 'return=representation' });
        return respond(200, Array.isArray(r.data) ? r.data[0] : r.data);
      }
      if (req.method === 'PUT' && id) {
        const r = await sb('PATCH', 'course_enrollments', 'id=eq.' + id, body, { prefer: 'return=representation' });
        return respond(200, Array.isArray(r.data) ? r.data[0] : r.data);
      }
    }

    // BRIDGE DATA (for password auth)
    if (resource === 'data') {
      if (req.method === 'GET') {
        const r = await sb('GET', 'bridge_data', 'order=key');
        const obj = {};
        if (Array.isArray(r.data)) r.data.forEach(row => { obj[row.key] = row.value; });
        return respond(200, obj);
      }
    }

    respond(404, { error: 'Not found: ' + resource });
  } catch (e) {
    console.error(e.message);
    respond(500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('Academia AM v1 on port ' + PORT);
  console.log('AI:', AI_PROVIDER || 'none');
  console.log('DB:', SUPABASE_URL ? 'ok' : 'missing');
  console.log('Frontend:', fs.existsSync(HTML_PATH) ? 'ok' : 'missing - will serve API only');
});
