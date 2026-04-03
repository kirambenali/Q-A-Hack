const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const ngrok = require('ngrok');

const PORT = 3000;
const HTML_FILE = path.join(__dirname, 'sirius_pitch_assistant.html');
const ENV_FILE = path.join(__dirname, '.env');

// ── Minimal .env parser (no external deps needed) ────────────────────────────
function loadEnv(filePath) {
  const env = {};
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      env[key] = value;
    }
  } catch (_) { /* .env missing – will show manual-config UI */ }
  return env;
}

// ── Simple JSON sanitiser for injected script tag ────────────────────────────
function esc(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── Derive region from speech endpoint hostname ──────────────────────────────
function regionFromEndpoint(endpoint) {
  try {
    const host = new URL(endpoint).hostname;
    return host.split('.')[0];
  } catch (_) { return 'eastus'; }
}

// ── Build the <script> block that is injected before window logic loads ───────
function buildConfigScript(env) {
  const speechEndpoint = env.AZURE_SPEECH_ENDPOINT || '';
  const speechRegion = env.AZURE_SPEECH_REGION || regionFromEndpoint(speechEndpoint) || 'eastus';

  return `<script id="azure-config">
window.AZURE_CONFIG = {
  openai: {
    endpoint:   "${esc(env.AZURE_OPENAI_ENDPOINT || '')}",
    key:        "${esc(env.AZURE_OPENAI_API_KEY || env.AZURE_OPENAI_KEY || '')}",
    deployment: "${esc(env.MODEL || env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini')}"
  },
  speech: {
    endpoint: "${esc(speechEndpoint)}",
    region:   "${esc(speechRegion)}",
    key:      "${esc(env.AZURE_SPEECH_KEY || '')}"
  }
};
</script>`;
}

// ── Request handler ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/sirius_pitch_assistant.html') {
    try {
      const env = loadEnv(ENV_FILE);
      let html = fs.readFileSync(HTML_FILE, 'utf8');
      const inject = buildConfigScript(env);

      // Inject right before the first <script> tag
      html = html.replace('<script>', inject + '\n<script>');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Error reading HTML file: ' + e.message);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Socket.io Setup with CORS (Crucial for ngrok/external access) ──────────────
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let users = {}; // socket.id -> { name, selectedNumber }

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    users[socket.id] = { id: socket.id, name, selectedNumber: null };
    io.emit('update-users', Object.values(users));
  });

  socket.on('choose-number', (num) => {
    if (users[socket.id]) {
      users[socket.id].selectedNumber = num;
      // Broadcast update
      io.emit('update-users', Object.values(users));
      io.emit('user-action', { name: users[socket.id].name, num });
    }
  });

  socket.on('disconnect', () => {
    if (users[socket.id]) {
      console.log(`[Socket] Disconnected: ${users[socket.id].name}`);
      delete users[socket.id];
      io.emit('update-users', Object.values(users));
    }
  });
});

server.listen(PORT, async () => {
  const env = loadEnv(ENV_FILE);
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   🚀 Sirius Pitch Assistant – Real-time Room!    ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Local Access: http://localhost:${PORT}             ║`);

  // Start ngrok automatically
  try {
    // If you have an authtoken, add it in your .env as NGROK_AUTHTOKEN
    if (env.NGROK_AUTHTOKEN) {
      await ngrok.authtoken(env.NGROK_AUTHTOKEN);
    }

    const publicUrl = await ngrok.connect(PORT);

  } catch (err) {
    console.log('║   ⚠️ ngrok error: ' + (err.message || 'Check connection').substring(0, 20).padEnd(20) + ' ║');
  }


});


