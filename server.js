const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const tasks = new Map();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- Facebook Message Sender ----------
async function sendFbMessage(token, recipientId, text) {
  try {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${token}`;
    const response = await axios.post(url, {
      recipient: { id: recipientId },
      message: { text: text },
      messaging_type: 'RESPONSE'
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    if (response.data && response.data.message_id) {
      return { success: true, messageId: response.data.message_id };
    }
    return { success: false, error: 'No message_id in response' };
  } catch (error) {
    const fbError = error.response?.data?.error?.message || error.message;
    console.error('Facebook API Error:', fbError);
    return { success: false, error: fbError };
  }
}

// ---------- Per-Token Sender Loop ----------
async function runTokenSender(task, token, tokenIndex) {
  if (!task.tokenMessageIndex) task.tokenMessageIndex = {};
  if (task.tokenMessageIndex[tokenIndex] === undefined) {
    task.tokenMessageIndex[tokenIndex] = 0;
  }

  while (task.active) {
    try {
      const messages = task.messages;
      if (!messages.length) {
        console.log(`No messages for task ${task.id}`);
        break;
      }
      
      const msgIndex = task.tokenMessageIndex[tokenIndex] % messages.length;
      const rawMessage = messages[msgIndex];
      const finalMessage = `${task.prefix} ${rawMessage}`;
      
      task.totalAttempts = (task.totalAttempts || 0) + 1;
      
      const result = await sendFbMessage(token, task.convoId, finalMessage);
      
      if (result.success) {
        task.successCount = (task.successCount || 0) + 1;
        console.log(`✅ Token ${token.substring(0,8)}... Sent: ${finalMessage.substring(0,50)}`);
      } else {
        task.failCount = (task.failCount || 0) + 1;
        console.log(`❌ Token ${token.substring(0,8)}... Failed: ${result.error}`);
      }
      
      task.tokenMessageIndex[tokenIndex]++;
      task.lastActivity = Date.now();
      
    } catch (err) {
      task.failCount = (task.failCount || 0) + 1;
      console.error(`Sender error for token ${tokenIndex}:`, err.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, task.speed * 1000));
  }
}

function startTask(task) {
  if (task.active) return;
  
  task.active = true;
  task.startTime = Date.now();
  task.totalAttempts = 0;
  task.successCount = 0;
  task.failCount = 0;
  task.tokenMessageIndex = {};
  
  console.log(`🚀 Starting task: ${task.name} with ${task.tokens.length} tokens`);
  
  task.senderPromises = task.tokens.map((token, idx) => 
    runTokenSender(task, token, idx)
  );
}

function stopTask(taskId, password) {
  const task = tasks.get(taskId);
  if (!task) return { success: false, error: 'Task not found' };
  if (task.password !== password) return { success: false, error: 'Invalid password' };
  if (!task.active) return { success: true, message: 'Task already stopped' };
  
  task.active = false;
  tasks.delete(taskId);
  console.log(`🛑 Task stopped: ${task.name}`);
  return { success: true, message: 'Task stopped successfully' };
}

function getTaskStats(task) {
  const uptime = task.active ? Math.floor((Date.now() - task.startTime) / 1000) : 0;
  return {
    id: task.id,
    name: task.name,
    uptime: uptime,
    total_messages: task.totalAttempts || 0,
    successful: task.successCount || 0,
    failed: task.failCount || 0,
    total_tokens: task.tokens.length,
    active: task.active,
    prefix: task.prefix,
    speed: task.speed,
    convo_id: task.convoId
  };
}

// ---------- Routes ----------
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FB Messenger Pro | Rikhil</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', Roboto; }
    body { background: linear-gradient(135deg, #0a0f1e 0%, #0a0a0a 100%); min-height: 100vh; padding: 2rem; color: #eee; }
    .container { max-width: 1200px; margin: 0 auto; }
    .card { background: rgba(17, 25, 40, 0.9); backdrop-filter: blur(10px); border-radius: 1.5rem; padding: 2rem; margin-bottom: 2rem; border: 1px solid rgba(0, 255, 200, 0.2); }
    .card h2 { margin-bottom: 1.5rem; color: #0cf; }
    .form-group { margin-bottom: 1rem; }
    label { display: block; margin-bottom: 0.5rem; font-weight: 600; color: #ccc; }
    input, select, textarea { width: 100%; padding: 0.75rem; background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; color: white; font-size: 1rem; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #0cf; }
    button { background: linear-gradient(95deg, #0a6, #0cf); color: white; padding: 0.75rem 1.5rem; border: none; border-radius: 0.75rem; font-weight: bold; cursor: pointer; font-size: 1rem; margin-top: 1rem; width: 100%; }
    button:hover { opacity: 0.9; transform: scale(1.01); }
    .task-card { background: #1e293b; border-radius: 1rem; padding: 1rem; margin-bottom: 1rem; border-left: 4px solid #0cf; }
    .task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .task-name { font-weight: bold; font-size: 1.1rem; color: #0cf; }
    .task-id { font-size: 0.7rem; color: #888; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 0.5rem; margin: 1rem 0; }
    .stat { background: #0f172a; padding: 0.5rem; border-radius: 0.5rem; text-align: center; }
    .stat-value { font-size: 1.2rem; font-weight: bold; color: #0cf; }
    .stat-label { font-size: 0.7rem; color: #aaa; }
    .stop-area { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .stop-area input { flex: 1; margin: 0; background: #0f172a; border-color: #f00; }
    .stop-btn { background: #f00; width: auto; margin: 0; padding: 0.5rem 1rem; }
    .token-selector { display: flex; gap: 1rem; margin-bottom: 1rem; }
    .token-option { display: flex; align-items: center; gap: 0.5rem; background: #1e293b; padding: 0.5rem 1rem; border-radius: 2rem; cursor: pointer; }
    .token-option input { width: auto; margin: 0; }
    .file-label { background: #1e293b; border: 1px dashed #0cf; border-radius: 0.75rem; padding: 0.75rem; text-align: center; cursor: pointer; }
    .file-label:hover { background: #2d3a5e; }
    .badge { background: #0cf; color: #000; padding: 0.2rem 0.6rem; border-radius: 1rem; font-size: 0.7rem; font-weight: bold; }
    hr { border-color: #334155; margin: 1rem 0; }
    .no-tasks { text-align: center; padding: 2rem; color: #888; }
  </style>
</head>
<body>
<div class="container">
  <div class="card">
    <h2>🚀 Facebook Messenger Automation</h2>
    <p>Support: EAAD / EAA Tokens | Page Messaging | Multi-Token</p>
    <hr>
    <form id="taskForm" enctype="multipart/form-data">
      <div class="token-selector">
        <label class="token-option"><input type="radio" name="token_type" value="single" checked> 🎫 Single Token</label>
        <label class="token-option"><input type="radio" name="token_type" value="multi"> 📁 Multiple Tokens (.txt)</label>
      </div>
      
      <div id="singleDiv">
        <div class="form-group">
          <label>Facebook Access Token</label>
          <textarea name="single_token" rows="2" placeholder="Paste your EAAD6v7... token here"></textarea>
        </div>
      </div>
      
      <div id="multiDiv" style="display:none">
        <div class="form-group">
          <label>Token File (one per line)</label>
          <input type="file" name="token_file" id="tokenFile" accept=".txt" style="display:none">
          <label for="tokenFile" class="file-label" id="tokenFileLabel">📂 Choose .txt file</label>
        </div>
      </div>
      
      <div class="form-group">
        <label>Task Name</label>
        <input type="text" name="task_name" placeholder="e.g., Summer Campaign" required>
      </div>
      
      <div class="form-group">
        <label>Task Password (to stop)</label>
        <input type="password" name="task_password" placeholder="Set a password" required>
      </div>
      
      <div class="form-group">
        <label>Recipient PSID (Facebook User ID)</label>
        <input type="text" name="convo_id" placeholder="Facebook PSID" required>
      </div>
      
      <div class="form-group">
        <label>Your Name Prefix (shows before each message)</label>
        <input type="text" name="prefix" placeholder="e.g., John Doe" required>
      </div>
      
      <div class="form-group">
        <label>Speed (seconds between messages per token)</label>
        <input type="number" name="speed" value="5" min="2" required>
      </div>
      
      <div class="form-group">
        <label>Message File (.txt, one message per line)</label>
        <input type="file" name="message_file" id="msgFile" accept=".txt" style="display:none" required>
        <label for="msgFile" class="file-label" id="msgFileLabel">📄 Choose message file</label>
      </div>
      
      <button type="submit">▶ START CAMPAIGN</button>
    </form>
  </div>
  
  <div class="card">
    <h2>⚡ Active Tasks <span id="taskCount" class="badge">0</span></h2>
    <div id="tasksContainer"></div>
  </div>
</div>

<script>
  // Toggle token inputs
  const radios = document.querySelectorAll('input[name="token_type"]');
  const singleDiv = document.getElementById('singleDiv');
  const multiDiv = document.getElementById('multiDiv');
  const singleToken = document.querySelector('textarea[name="single_token"]');
  const tokenFile = document.getElementById('tokenFile');
  
  radios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.value === 'single') {
        singleDiv.style.display = 'block';
        multiDiv.style.display = 'none';
        singleToken.required = true;
        if(tokenFile) tokenFile.required = false;
      } else {
        singleDiv.style.display = 'none';
        multiDiv.style.display = 'block';
        singleToken.required = false;
        if(tokenFile) tokenFile.required = true;
      }
    });
  });
  
  // File labels
  document.getElementById('tokenFile')?.addEventListener('change', (e) => {
    const label = document.getElementById('tokenFileLabel');
    if(e.target.files.length) label.innerHTML = '✓ ' + e.target.files[0].name;
    else label.innerHTML = '📂 Choose .txt file';
  });
  
  document.getElementById('msgFile')?.addEventListener('change', (e) => {
    const label = document.getElementById('msgFileLabel');
    if(e.target.files.length) label.innerHTML = '✓ ' + e.target.files[0].name;
    else label.innerHTML = '📄 Choose message file';
  });
  
  // Form submit
  document.getElementById('taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.innerText = '⏳ Creating...';
    try {
      const res = await fetch('/', { method: 'POST', body: formData });
      const data = await res.json();
      if(data.success) {
        alert('✅ Task started successfully!');
        e.target.reset();
        fetchTasks();
      } else {
        alert('❌ Error: ' + data.error);
      }
    } catch(err) {
      alert('❌ Server error: ' + err.message);
    } finally {
      btn.innerText = '▶ START CAMPAIGN';
    }
  });
  
  // Fetch and render tasks
  async function fetchTasks() {
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json();
      if(data.success) renderTasks(data.tasks);
    } catch(e) { console.error(e); }
  }
  
  function renderTasks(tasks) {
    const container = document.getElementById('tasksContainer');
    const countSpan = document.getElementById('taskCount');
    countSpan.innerText = tasks.length;
    if(!tasks.length) {
      container.innerHTML = '<div class="no-tasks">✨ No active tasks. Create one above.</div>';
      return;
    }
    container.innerHTML = tasks.map(t => \`
      <div class="task-card" id="task-\${t.id}">
        <div class="task-header">
          <span class="task-name">\${escapeHtml(t.name)}</span>
          <span class="task-id">#\${t.id.slice(0,6)}</span>
        </div>
        <div>👤 \${escapeHtml(t.prefix)} | 💬 \${t.convo_id} | ⚡ \${t.speed}s</div>
        <div class="stats">
          <div class="stat"><div class="stat-value">\${formatTime(t.uptime)}</div><div class="stat-label">Uptime</div></div>
          <div class="stat"><div class="stat-value">\${t.total_messages}</div><div class="stat-label">Sent</div></div>
          <div class="stat"><div class="stat-value" style="color:#0f0;">\${t.successful}</div><div class="stat-label">Success</div></div>
          <div class="stat"><div class="stat-value" style="color:#f66;">\${t.failed}</div><div class="stat-label">Failed</div></div>
          <div class="stat"><div class="stat-value">\${t.total_tokens}</div><div class="stat-label">Tokens</div></div>
        </div>
        <div class="stop-area">
          <input type="password" id="pwd-\${t.id}" placeholder="Task password to stop">
          <button class="stop-btn" onclick="stopTask('\${t.id}')">⏹️ Stop</button>
        </div>
      </div>
    \`).join('');
  }
  
  window.stopTask = async (id) => {
    const pwd = document.getElementById('pwd-' + id).value;
    if(!pwd) return alert('Enter task password');
    const btn = event?.target;
    if(btn) btn.innerText = '⏳...';
    try {
      const res = await fetch('/stop/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      const data = await res.json();
      if(data.success) {
        alert('✅ ' + data.message);
        fetchTasks();
      } else {
        alert('❌ ' + data.error);
      }
    } catch(e) { alert('Error: ' + e.message); }
    finally { if(btn) btn.innerText = '⏹️ Stop'; }
  };
  
  function formatTime(sec) {
    if(sec < 60) return sec + 's';
    let m = Math.floor(sec/60);
    if(m < 60) return m + 'm';
    let h = Math.floor(m/60);
    return h + 'h ' + (m%60) + 'm';
  }
  
  function escapeHtml(str) {
    return str.replace(/[&<>]/g, function(m) {
      if(m === '&') return '&amp;';
      if(m === '<') return '&lt;';
      if(m === '>') return '&gt;';
      return m;
    });
  }
  
  // Auto-refresh every 5 seconds
  fetchTasks();
  setInterval(fetchTasks, 5000);
</script>
</body>
</html>
  `);
});

// ---------- API: Create Task ----------
app.post('/', upload.fields([
  { name: 'token_file', maxCount: 1 },
  { name: 'message_file', maxCount: 1 }
]), async (req, res) => {
  try {
    const { token_type, single_token, task_name, task_password, convo_id, prefix, speed } = req.body;
    
    // Validation
    if (!task_name || !task_password || !convo_id || !prefix || !speed) {
      return res.status(400).json({ success: false, error: 'All fields required' });
    }
    
    const speedNum = parseInt(speed);
    if (speedNum < 2) {
      return res.status(400).json({ success: false, error: 'Speed must be at least 2 seconds' });
    }
    
    // Parse tokens
    let tokens = [];
    if (token_type === 'single') {
      if (!single_token) {
        return res.status(400).json({ success: false, error: 'Single token required' });
      }
      tokens = [single_token.trim()];
    } else {
      const tokenFile = req.files['token_file'] ? req.files['token_file'][0] : null;
      if (!tokenFile) {
        return res.status(400).json({ success: false, error: 'Token file required for multi-token mode' });
      }
      const content = tokenFile.buffer.toString('utf-8');
      tokens = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      if (tokens.length === 0) {
        return res.status(400).json({ success: false, error: 'Token file is empty' });
      }
    }
    
    // Parse messages
    const msgFile = req.files['message_file'] ? req.files['message_file'][0] : null;
    if (!msgFile) {
      return res.status(400).json({ success: false, error: 'Message file required' });
    }
    const msgContent = msgFile.buffer.toString('utf-8');
    const messages = msgContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (messages.length === 0) {
      return res.status(400).json({ success: false, error: 'Message file contains no valid lines' });
    }
    
    // Create task
    const taskId = crypto.randomBytes(6).toString('hex');
    const task = {
      id: taskId,
      name: task_name,
      password: task_password,
      convoId: convo_id,
      prefix: prefix,
      speed: speedNum,
      tokens: tokens,
      messages: messages,
      active: false
    };
    
    tasks.set(taskId, task);
    startTask(task);
    
    console.log(`✅ Task created: ${task_name} (${taskId}) with ${tokens.length} tokens, ${messages.length} messages`);
    res.json({ success: true, taskId: taskId });
    
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- API: Get All Tasks ----------
app.get('/api/tasks', (req, res) => {
  const taskList = [];
  for (let task of tasks.values()) {
    taskList.push(getTaskStats(task));
  }
  res.json({ success: true, tasks: taskList });
});

// ---------- API: Stop Task ----------
app.post('/stop/:taskId', (req, res) => {
  const { taskId } = req.params;
  const { password } = req.body;
  const result = stopTask(taskId, password);
  res.json(result);
});

// ---------- Health Check ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`✅ Ready for Facebook Messenger automation`);
});
