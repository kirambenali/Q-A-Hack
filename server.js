const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const ngrok = require('ngrok');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// ── Minimal .env parser (redundant now with dotenv but kept for the injected script) ──
function loadEnv() {
  const env = {};
  const filePath = path.join(__dirname, '.env');
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
  } catch (_) {}
  return env;
}

function esc(s) { return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

app.get('/', (req, res) => {
  const env = loadEnv();
  let html = fs.readFileSync(path.join(__dirname, 'sirius_pitch_assistant.html'), 'utf8');
  
  const speechEndpoint = env.AZURE_SPEECH_ENDPOINT || '';
  const speechRegion = env.AZURE_SPEECH_REGION || 'eastus';
  
  const inject = `
<script id="azure-config">
window.AZURE_CONFIG = {
  openai: {
    endpoint:   "${esc(env.AZURE_OPENAI_ENDPOINT || '')}",
    key:        "${esc(env.AZURE_OPENAI_API_KEY || env.AZURE_OPENAI_KEY || '')}",
    deployment: "${esc(env.MODEL || 'gpt-4o-mini')}"
  },
  speech: {
    endpoint: "${esc(speechEndpoint)}",
    region:   "${esc(speechRegion)}",
    key:      "${esc(env.AZURE_SPEECH_KEY || '')}"
  }
};
</script>`;
  
  html = html.replace('<script>', inject + '\n<script>');
  res.send(html);
});

// Store processed text globally for the team room
let sessionData = {}; // socketId -> { id, name, score, context }
let globalRoomContext = ""; // Shared knowledge for all members

app.post('/upload', upload.array('files'), async (req, res) => {
  const { socketId } = req.body;
  if (!req.files || req.files.length === 0) return res.status(400).send('No files uploaded.');

  let fullText = "";
  try {
    for (const file of req.files) {
      const filePath = file.path;
      console.log(`Processing file: ${file.originalname} (${file.mimetype})`);
      if (file.mimetype === 'application/pdf') {
        const dataBuffer = fs.readFileSync(filePath);
        try {
          const data = await (typeof pdf === 'function' ? pdf(dataBuffer) : (pdf.PDFParse ? pdf.PDFParse.read(dataBuffer) : pdf.default(dataBuffer)));
          console.log(`PDF Extraction Success: ${data.text.length} characters found.`);
          fullText += data.text + "\n\n";
        } catch (e) {
          console.error(`PDF Parse Error for ${file.originalname}:`, e);
        }
      } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const data = await mammoth.extractRawText({ path: filePath });
        console.log(`DOCX Extraction Success: ${data.value.length} characters found.`);
        fullText += data.value + "\n\n";
      } else {
        const text = fs.readFileSync(filePath, 'utf8');
        console.log(`Text Extraction Success: ${text.length} characters found.`);
        fullText += text + "\n\n";
      }
      // Clean up file safely (Optional: keep them for debugging)
      /*try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.warn(`Could not delete temp file: ${filePath}. It might be in use.`);
      }*/
    }

    if (sessionData[socketId]) {
      sessionData[socketId].context = fullText;
    }
    // Update Global Knowledge
    globalRoomContext = (globalRoomContext ? globalRoomContext + "\n\n" : "") + fullText;
    console.log(`Global Room Knowledge updated. Total size: ${globalRoomContext.length} chars.`);

    res.json({ success: true, textLength: fullText.length });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error processing files.');
  }
});

app.get('/context', (req, res) => {
  const { socketId } = req.query;
  const userContext = (sessionData[socketId] && sessionData[socketId].context) ? sessionData[socketId].context : "";
  // Return the team's global brain if no specific user context exists
  res.json({ context: userContext || globalRoomContext || "" });
});

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    if (!sessionData[socket.id]) sessionData[socket.id] = {};
    sessionData[socket.id].id = socket.id;
    sessionData[socket.id].name = name;
    sessionData[socket.id].score = sessionData[socket.id].score || 0;
    io.emit('update-users', Object.values(sessionData));
  });

  let highestTimeout = null;

  socket.on('select-num', (num) => {
    if (sessionData[socket.id]) {
      // Toggle logic: if same num, deselect (0)
      if (sessionData[socket.id].score === num) {
        sessionData[socket.id].score = 0;
      } else {
        sessionData[socket.id].score = num;
      }

      const users = Object.values(sessionData);
      io.emit('update-users', users);
      
      // Debounce: Wait 400ms before announcing the winner (Pitch Optimized)
      if (highestTimeout) clearTimeout(highestTimeout);
      highestTimeout = setTimeout(() => {
        const usersInRoom = Object.values(sessionData);
        const highest = usersInRoom.reduce((max, u) => (u.score > max.score ? u : max), { score: 0 });
        
        if (highest.score > 0) {
          io.emit('highest-selected', { name: highest.name, score: highest.score, id: highest.id });
        }
      }, 400);
    }
  });

  socket.on('ai-response-start', () => {
    io.emit('ai-response-start');
  });

  socket.on('ai-response-chunk', (chunk) => {
    io.emit('ai-response-chunk', chunk);
  });

  socket.on('disconnect', () => {
    delete sessionData[socket.id];
    io.emit('update-users', Object.values(sessionData));
  });
});

server.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  try {
    const publicUrl = await ngrok.connect({
      addr: PORT,
      authtoken: process.env.NGROK_AUTHTOKEN || null
    });
    console.log(`Ngrok tunnel: ${publicUrl}`);
  } catch (e) {
    console.warn('Ngrok could not be started. Local access only (http://localhost:3000).');
  }
});
