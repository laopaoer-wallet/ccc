const TASK_KEY_PREFIX = 'task:';
const AUTH_COOKIE_NAME = 'scheduler_auth';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24; // 1 day

const tasksCache = new Map();
let initializationPromise = null;
let cachedAuthToken = null;
let cachedPasswordValue = null;

class TaskScheduler {
  constructor() {
    this.scheduledTasks = new Map();
  }

  scheduleTask(task, env) {
    this.clearScheduledTask(task.id);

    const interval = this.getInterval(task.scheduleType);
    const timeoutId = setTimeout(async () => {
      const refreshedTask = await this.executeTask(task, env);
      if (
        refreshedTask &&
        refreshedTask.isActive &&
        refreshedTask.scheduleType !== 'once'
      ) {
        this.scheduleTask(refreshedTask, env);
      }
    }, interval);

    this.scheduledTasks.set(task.id, timeoutId);
  }

  getInterval(scheduleType) {
    switch (scheduleType) {
      case 'minute':
        return 60 * 1000;
      case 'hourly':
        return 60 * 60 * 1000;
      case 'daily':
        return 24 * 60 * 60 * 1000;
      case 'weekly':
        return 7 * 24 * 60 * 60 * 1000;
      default:
        return 5 * 60 * 1000;
    }
  }

  async executeTask(task, env) {
    console.log(`Executing task ${task.id}: ${task.name}`);
    const currentTask = tasksCache.get(task.id) || task;
    const updatedTask = { ...currentTask };

    try {
      const response = await fetch(task.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Cloudflare-Worker-Scheduler'
        },
        body: JSON.stringify({
          taskId: task.id,
          taskName: task.name,
          timestamp: new Date().toISOString(),
          message: 'Scheduled task execution'
        })
      });

      const result = await response.text();

      updatedTask.lastRun = new Date().toISOString();
      updatedTask.lastStatus = response.ok ? 'success' : 'failed';
      updatedTask.lastResponse = result.substring(0, 100);

      console.log(
        `Task ${task.id} executed. Status: ${response.status}, Response: ${result}`
      );
    } catch (error) {
      console.error(`Error executing task ${task.id}:`, error);

      updatedTask.lastRun = new Date().toISOString();
      updatedTask.lastStatus = 'error';
      updatedTask.lastResponse = error.message;
    }

    tasksCache.set(task.id, updatedTask);
    await persistTask(env, updatedTask);
    return updatedTask;
  }

  clearScheduledTask(taskId) {
    const timeoutId = this.scheduledTasks.get(taskId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.scheduledTasks.delete(taskId);
    }
  }

  clearAll() {
    for (const [, timeoutId] of this.scheduledTasks) {
      clearTimeout(timeoutId);
    }
    this.scheduledTasks.clear();
  }
}

const scheduler = new TaskScheduler();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/login') {
      return handleLogin(request, env);
    }

    if (path === '/logout' && method === 'POST') {
      return handleLogout();
    }

    const requiresAuth = Boolean(env.ADMIN_PASSWORD);
    if (requiresAuth) {
      const authorized = await authenticate(request, env);
      if (!authorized) {
        if (path.startsWith('/api/')) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }

        if (method === 'GET') {
          return renderLoginPage();
        }

        return new Response('', {
          status: 302,
          headers: { Location: '/login' }
        });
      }
    }

    if (path === '/' || path === '/index.html') {
      return handleUI();
    }

    if (path.startsWith('/api/')) {
      await ensureInitialized(env);
      return handleAPI(request, method, env);
    }

    return handleUI();
  }
};

async function ensureInitialized(env) {
  if (!initializationPromise) {
    initializationPromise = loadTasksFromKV(env);
  }
  await initializationPromise;
}

async function loadTasksFromKV(env) {
  scheduler.clearAll();
  tasksCache.clear();

  let cursor = undefined;
  do {
    const { keys, cursor: nextCursor } = await env.TASKS_KV.list({
      prefix: TASK_KEY_PREFIX,
      cursor
    });

    if (keys && keys.length > 0) {
      const entries = await Promise.all(
        keys.map((key) => env.TASKS_KV.get(key.name, { type: 'json' }))
      );

      for (const task of entries) {
        if (!task || !task.id) continue;

        tasksCache.set(task.id, task);

        if (shouldAutoSchedule(task)) {
          scheduler.scheduleTask(task, env);
        }
      }
    }

    cursor = nextCursor;
  } while (cursor);
}

function shouldAutoSchedule(task) {
  if (!task.isActive) return false;
  if (task.scheduleType === 'once' && task.lastRun) return false;
  return true;
}

function getTasksArray() {
  return Array.from(tasksCache.values()).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1
  );
}

function getTaskKey(taskId) {
  return `${TASK_KEY_PREFIX}${taskId}`;
}

async function persistTask(env, task) {
  await env.TASKS_KV.put(getTaskKey(task.id), JSON.stringify(task));
}

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return new Response('', {
      status: 302,
      headers: { Location: '/' }
    });
  }

  if (request.method === 'GET') {
    return renderLoginPage();
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const contentType = request.headers.get('Content-Type') || '';
  let password = '';

  try {
    if (contentType.includes('application/json')) {
      const body = await request.json();
      password = body.password || '';
    } else {
      const formData = await request.formData();
      password = formData.get('password') || '';
    }
  } catch (error) {
    console.error('Failed to parse login payload:', error);
    return renderLoginPage('请求格式不正确，请重试。', 400);
  }

  if (!password) {
    return renderLoginPage('请输入密码。', 400);
  }

  if (password !== env.ADMIN_PASSWORD) {
    return renderLoginPage('密码错误，请重试。', 401);
  }

  const token = await getExpectedAuthToken(env);

  return new Response('', {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `${AUTH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Max-Age=${AUTH_COOKIE_MAX_AGE}; Path=/`
    }
  });
}

function renderLoginPage(message = '', status = 200) {
  const messageHtml = message
    ? `<div class="login-alert">${escapeHtmlString(message)}</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 | Cloudflare Worker 定时任务管理</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #3498db, #8e44ad);
            padding: 20px;
        }
        .login-card {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 16px;
            padding: 32px;
            width: min(360px, 100%);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
        }
        .login-card h1 {
            margin: 0;
            font-size: 24px;
            color: #2c3e50;
        }
        .login-card p {
            color: #7f8c8d;
            margin-top: 8px;
            margin-bottom: 24px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #2c3e50;
        }
        input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #ecf0f1;
            border-radius: 6px;
            font-size: 14px;
        }
        input[type="password"]:focus {
            border-color: #3498db;
            outline: none;
        }
        button {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 6px;
            background: #3498db;
            color: white;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s ease;
        }
        button:hover {
            background: #2980b9;
        }
        .login-alert {
            background: rgba(231, 76, 60, 0.15);
            color: #c0392b;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            border: 1px solid rgba(231, 76, 60, 0.3);
        }
        .footer-note {
            margin-top: 24px;
            font-size: 12px;
            color: rgba(0, 0, 0, 0.5);
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="login-card">
        <h1>🔒 安全登录</h1>
        <p>请输入访问密码以管理定时任务</p>
        ${messageHtml}
        <form method="POST" action="/login">
            <div class="form-group">
                <label for="password">访问密码</label>
                <input type="password" id="password" name="password" required placeholder="输入访问密码" autofocus>
            </div>
            <button type="submit">登录</button>
        </form>
        <div class="footer-note">Cloudflare Worker Scheduler</div>
    </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8'
    }
  });
}

async function handleLogout() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`
    }
  });
}

async function authenticate(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return true;
  }

  const cookies = parseCookies(request.headers.get('Cookie'));
  if (!cookies[AUTH_COOKIE_NAME]) {
    return false;
  }

  const expectedToken = await getExpectedAuthToken(env);
  return cookies[AUTH_COOKIE_NAME] === expectedToken;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) {
    return cookies;
  }

  const pairs = header.split(';');
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

async function getExpectedAuthToken(env) {
  if (!env.ADMIN_PASSWORD) {
    return null;
  }

  if (
    cachedAuthToken === null ||
    cachedPasswordValue !== env.ADMIN_PASSWORD
  ) {
    cachedAuthToken = await hashString(env.ADMIN_PASSWORD);
    cachedPasswordValue = env.ADMIN_PASSWORD;
  }

  return cachedAuthToken;
}

async function hashString(value) {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return btoa(String.fromCharCode(...hashArray));
}

function escapeHtmlString(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function handleUI() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare Worker 定时任务管理</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
            margin-bottom: 30px;
        }
        .header h1 {
            color: #2c3e50;
            margin: 0;
        }
        .header p {
            color: #7f8c8d;
            margin: 4px 0 0 0;
        }
        .header-text {
            display: flex;
            flex-direction: column;
        }
        .content {
            display: grid;
            grid-template-columns: 1fr 2fr;
            gap: 30px;
        }
        @media (max-width: 960px) {
            .content {
                grid-template-columns: 1fr;
            }
        }
        .form-section, .tasks-section {
            padding: 20px;
        }
        .section-title {
            font-size: 20px;
            margin-bottom: 20px;
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
        }
        .form-group input,
        .form-group select,
        .form-group textarea {
            width: 100%;
            padding: 12px;
            border: 2px solid #ecf0f1;
            border-radius: 6px;
            font-size: 14px;
        }
        .form-group input:focus,
        .form-group select:focus,
        .form-group textarea:focus {
            outline: none;
            border-color: #3498db;
        }
        .btn {
            background: #3498db;
            color: white;
            padding: 12px 24px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            margin-right: 10px;
            margin-bottom: 10px;
            transition: all 0.2s ease;
        }
        .btn:hover {
            background: #2980b9;
        }
        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .btn-secondary {
            background: #ecf0f1;
            color: #2c3e50;
        }
        .btn-secondary:hover {
            background: #d5d8dc;
        }
        .btn-danger {
            background: #e74c3c;
        }
        .btn-danger:hover {
            background: #c0392b;
        }
        .btn-danger-light {
            background: rgba(231, 76, 60, 0.1);
            color: #e74c3c;
            border: 1px solid rgba(231, 76, 60, 0.3);
            padding: 10px 18px;
        }
        .btn-danger-light:hover {
            background: #e74c3c;
            color: white;
        }
        .task-item {
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 15px;
        }
        .task-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            gap: 12px;
            flex-wrap: wrap;
        }
        .task-name {
            font-size: 18px;
            font-weight: 600;
            color: #2c3e50;
        }
        .task-id {
            font-size: 12px;
            color: #7f8c8d;
            font-family: monospace;
        }
        .task-actions {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }
        .status-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .status-success {
            background: #d4edda;
            color: #155724;
        }
        .status-pending {
            background: #fff3cd;
            color: #856404;
        }
        .status-failed {
            background: #f8d7da;
            color: #721c24;
        }
        .status-error {
            background: #fdecea;
            color: #b71c1c;
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: #7f8c8d;
        }
        .toast {
            position: fixed;
            top: 32px;
            left: 50%;
            transform: translate(-50%, -20px);
            background: #2c3e50;
            color: white;
            padding: 14px 24px;
            border-radius: 999px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.25s ease, transform 0.25s ease;
            z-index: 2000;
        }
        .toast.show {
            opacity: 1;
            transform: translate(-50%, 0);
        }
        .toast-success {
            background: #2ecc71;
        }
        .toast-error {
            background: #e74c3c;
        }
        .toast-info {
            background: #3498db;
        }
        .modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.25s ease;
            z-index: 1500;
        }
        .modal-overlay.show {
            opacity: 1;
            pointer-events: all;
        }
        .modal {
            background: white;
            padding: 28px 32px;
            border-radius: 16px;
            max-width: 420px;
            width: 90%;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.12);
        }
        .modal h3 {
            margin: 0 0 12px 0;
            font-size: 20px;
            color: #2c3e50;
        }
        .modal p {
            margin: 0;
            color: #4a4a4a;
            line-height: 1.6;
        }
        .modal-actions {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            margin-top: 24px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-text">
                <h1>🕒 Cloudflare Worker 定时任务管理</h1>
                <p>轻松管理和调度你的定时 Webhook 任务</p>
            </div>
            <button class="btn btn-secondary" id="logoutButton">🔒 退出登录</button>
        </div>

        <div class="content">
            <div class="form-section">
                <h2 class="section-title">📝 创建新任务</h2>
                <form id="taskForm">
                    <div class="form-group">
                        <label for="taskName">任务名称 *</label>
                        <input type="text" id="taskName" name="taskName" required placeholder="输入任务名称">
                    </div>

                    <div class="form-group">
                        <label for="webhookUrl">Webhook URL *</label>
                        <input type="url" id="webhookUrl" name="webhookUrl" required placeholder="https://example.com/webhook">
                    </div>

                    <div class="form-group">
                        <label for="scheduleType">调度类型 *</label>
                        <select id="scheduleType" name="scheduleType" required>
                            <option value="">选择调度类型</option>
                            <option value="minute">每分钟 (测试)</option>
                            <option value="hourly">每小时</option>
                            <option value="daily">每天</option>
                            <option value="weekly">每周</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label for="taskDescription">任务描述</label>
                        <textarea id="taskDescription" name="taskDescription" placeholder="任务描述（可选）"></textarea>
                    </div>

                    <button type="submit" class="btn">✅ 创建任务</button>
                </form>
            </div>

            <div class="tasks-section">
                <h2 class="section-title">⏰ 任务列表</h2>
                <div id="tasksList">
                    <div class="empty-state">
                        <p>暂无任务，请创建第一个定时任务</p>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div id="toast" class="toast toast-info" role="status" aria-live="polite"></div>

    <div id="modalOverlay" class="modal-overlay" role="dialog" aria-modal="true" aria-hidden="true">
        <div class="modal">
            <h3>确认删除</h3>
            <p id="confirmText">确定要删除该任务吗？</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelDeleteBtn">取消</button>
                <button class="btn btn-danger" id="confirmDeleteBtn">确定删除</button>
            </div>
        </div>
    </div>

    <script>
        let tasks = [];
        let pendingDeleteId = null;
        let toastTimeoutId = null;

        const taskForm = document.getElementById('taskForm');
        const tasksListElement = document.getElementById('tasksList');
        const toastElement = document.getElementById('toast');
        const modalOverlay = document.getElementById('modalOverlay');
        const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
        const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
        const confirmText = document.getElementById('confirmText');
        const logoutButton = document.getElementById('logoutButton');

        if (logoutButton) {
            logoutButton.addEventListener('click', logout);
        }

        taskForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const formData = new FormData(e.target);
            const taskData = Object.fromEntries(formData.entries());

            try {
                const response = await fetch('/api/tasks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(taskData)
                });

                let responseData = {};
                try {
                    responseData = await response.json();
                } catch (_) {
                    responseData = {};
                }

                if (response.ok) {
                    showToast('任务创建成功！', 'success');
                    e.target.reset();
                    loadTasks();
                } else {
                    showToast('创建任务失败：' + (responseData.error || responseData.message || '未知错误'), 'error');
                }
            } catch (error) {
                showToast('创建任务失败：' + error.message, 'error');
            }
        });

        cancelDeleteBtn.addEventListener('click', () => closeConfirmModal());
        modalOverlay.addEventListener('click', (event) => {
            if (event.target === modalOverlay) {
                closeConfirmModal();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeConfirmModal();
            }
        });

        confirmDeleteBtn.addEventListener('click', handleConfirmDelete);

        async function logout() {
            if (logoutButton) {
                logoutButton.disabled = true;
                logoutButton.textContent = '处理中...';
            }

            try {
                const response = await fetch('/logout', { method: 'POST' });
                if (response.ok) {
                    window.location.href = '/login';
                } else {
                    showToast('退出失败，请重试。', 'error');
                }
            } catch (error) {
                showToast('退出失败：' + error.message, 'error');
            } finally {
                if (logoutButton) {
                    logoutButton.disabled = false;
                    logoutButton.textContent = '🔒 退出登录';
                }
            }
        }

        async function handleConfirmDelete() {
            if (!pendingDeleteId) return;

            confirmDeleteBtn.disabled = true;
            const originalText = confirmDeleteBtn.textContent;
            confirmDeleteBtn.textContent = '处理中...';

            const taskId = pendingDeleteId;
            const succeeded = await performDelete(taskId);

            confirmDeleteBtn.disabled = false;
            confirmDeleteBtn.textContent = originalText;

            if (succeeded) {
                closeConfirmModal();
            }
        }

        async function loadTasks() {
            try {
                const response = await fetch('/api/tasks');
                if (response.status === 401) {
                    window.location.href = '/login';
                    return;
                }
                tasks = await response.json();
                renderTasks();
            } catch (error) {
                console.error('加载任务失败：', error);
                showToast('加载任务失败：' + error.message, 'error');
            }
        }

        function renderTasks() {
            if (!tasksListElement) return;

            if (!tasks || tasks.length === 0) {
                tasksListElement.innerHTML = '<div class="empty-state"><p>暂无任务，请创建第一个定时任务</p></div>';
                return;
            }

            const markup = tasks
                .map((task) => {
                    const safeName = escapeHtml(task.name);
                    const safeWebhook = escapeHtml(task.webhookUrl);
                    const safeCreatedAt = escapeHtml(task.createdAt || '');
                    const safeLastRun = escapeHtml(task.lastRun || '');
                    const statusText = getStatusText(task.lastStatus);
                    const statusClass = getStatusClass(task.lastStatus);
                    const scheduleText = getScheduleText(task.scheduleType);
                    const encodedName = encodeURIComponent(task.name || '');

                    const lastRunMarkup = task.lastRun
                        ? '<div><strong>最后执行:</strong> ' + safeLastRun + '</div>'
                        : '';

                    const statusDetailMarkup =
                        task.lastStatus === 'success' || task.lastStatus === 'failed'
                            ? '<div><strong>状态:</strong> ' + statusText + '</div>'
                            : '';

                    return `
                <div class="task-item">
                    <div class="task-header">
                        <div>
                            <div class="task-name">${safeName}</div>
                            <div class="task-id">ID: ${task.id}</div>
                        </div>
                        <div class="task-actions">
                            <span class="status-badge ${statusClass}">${statusText}</span>
                            <button class="btn btn-danger-light btn-delete" data-id="${task.id}" data-name="${encodedName}">🗑 删除</button>
                        </div>
                    </div>
                    <div>
                        <div><strong>Webhook:</strong> ${safeWebhook}</div>
                        <div><strong>调度类型:</strong> ${scheduleText}</div>
                        <div><strong>创建时间:</strong> ${safeCreatedAt}</div>
                        ${lastRunMarkup}
                        ${statusDetailMarkup}
                    </div>
                </div>
            `;
                })
                .join('');

            tasksListElement.innerHTML = markup;
            attachTaskActionHandlers();
        }

        function attachTaskActionHandlers() {
            const buttons = document.querySelectorAll('.btn-delete');
            buttons.forEach((button) => {
                button.addEventListener('click', () => {
                    const taskId = button.dataset.id;
                    const taskName = decodeURIComponent(button.dataset.name || '');
                    openDeleteConfirm(taskId, taskName);
                });
            });
        }

        function openDeleteConfirm(taskId, taskName) {
            pendingDeleteId = taskId;
            confirmText.textContent = '确定要删除任务「' + (taskName || '') + '」吗？';
            modalOverlay.setAttribute('aria-hidden', 'false');
            modalOverlay.classList.add('show');
        }

        function closeConfirmModal() {
            modalOverlay.classList.remove('show');
            modalOverlay.setAttribute('aria-hidden', 'true');
            pendingDeleteId = null;
        }

        async function performDelete(taskId) {
            try {
                const response = await fetch('/api/tasks/' + encodeURIComponent(taskId), {
                    method: 'DELETE'
                });

                let data = {};
                try {
                    data = await response.json();
                } catch (_) {
                    data = {};
                }

                if (response.ok) {
                    showToast('任务已删除', 'success');
                    loadTasks();
                    return true;
                }

                if (response.status === 401) {
                    window.location.href = '/login';
                    return false;
                }

                showToast('删除失败：' + (data.message || data.error || '未知错误'), 'error');
                return false;
            } catch (error) {
                showToast('删除失败：' + error.message, 'error');
                return false;
            }
        }

        function showToast(message, type = 'info') {
            if (!toastElement) return;

            toastElement.textContent = message;
            toastElement.className = 'toast toast-' + type;

            requestAnimationFrame(() => {
                toastElement.classList.add('show');
            });

            if (toastTimeoutId) {
                clearTimeout(toastTimeoutId);
            }

            toastTimeoutId = setTimeout(() => {
                toastElement.classList.remove('show');
            }, 2800);
        }

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function getStatusClass(status) {
            switch (status) {
                case 'success':
                    return 'status-success';
                case 'failed':
                    return 'status-failed';
                case 'error':
                    return 'status-error';
                default:
                    return 'status-pending';
            }
        }

        function getStatusText(status) {
            const statusMap = {
                success: '成功',
                failed: '失败',
                error: '错误',
                pending: '等待中'
            };
            return statusMap[status] || '等待中';
        }

        function getScheduleText(scheduleType) {
            const scheduleMap = {
                minute: '每分钟',
                hourly: '每小时',
                daily: '每天',
                weekly: '每周'
            };
            return scheduleMap[scheduleType] || scheduleType;
        }

        loadTasks();
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8'
    }
  });
}

async function handleAPI(request, method, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/tasks') {
    if (method === 'GET') return getTasks(env);
    if (method === 'POST') return createTask(request, env);
  }

  const match = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (match && method === 'DELETE') {
    return deleteTask(match[1], env);
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getTasks(env) {
  await ensureInitialized(env);

  return new Response(JSON.stringify(getTasksArray()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function createTask(request, env) {
  await ensureInitialized(env);

  try {
    const data = await request.json();

    const task = {
      id: crypto.randomUUID(),
      name: data.taskName,
      webhookUrl: data.webhookUrl,
      scheduleType: data.scheduleType,
      description: data.taskDescription || '',
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastStatus: 'pending',
      lastResponse: null,
      isActive: true
    };

    tasksCache.set(task.id, task);
    await persistTask(env, task);

    if (shouldAutoSchedule(task)) {
      scheduler.scheduleTask(task, env);
    }

    return new Response(
      JSON.stringify({
        success: true,
        taskId: task.id,
        message: '任务创建成功'
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

async function deleteTask(taskId, env) {
  await ensureInitialized(env);

  const task = tasksCache.get(taskId);
  if (!task) {
    return new Response(
      JSON.stringify({ success: false, message: '任务不存在' }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  scheduler.clearScheduledTask(taskId);
  tasksCache.delete(taskId);
  await env.TASKS_KV.delete(getTaskKey(taskId));

  return new Response(
    JSON.stringify({ success: true, message: '任务已删除' }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
