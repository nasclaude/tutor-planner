// Where the Cloudflare Worker (the API that stores data and sends reminders) lives.
// Local preview: the API runs on the page's port + 707 (http://localhost:8080 -> :8787).
window.APP_CONFIG = {
  apiBase: ['localhost', '127.0.0.1'].includes(location.hostname)
    ? `http://${location.hostname}:${Number(location.port || 80) + 707}`
    : 'https://tutor-planner-api.tutor-planner-api.workers.dev',
};
