// Small DOM helpers. All text goes through textContent, never innerHTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(root, ...children) {
  root.replaceChildren();
  append(root, children);
}

let toastTimer;
export function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3000);
}

// Friendly messages for errors raised by the database functions.
const KNOWN = {
  'HW:time_up': "Time is up for this section, so answers can't be changed.",
  'HW:section_closed': 'This section is finished, so answers are locked.',
  'HW:submitted': 'This assignment has already been submitted.',
  'HW:not_submitted': 'Results are available after you submit.',
  'HW:section_not_started': 'Start the section before answering.',
  'HW:bad_answer': 'Answers can be A–D, or a number like 12, -3, .75 or 3/4.',
  'HW:not_found': "That item wasn't found, or you don't have access to it.",
  'HW:forbidden': "You don't have permission to do that.",
};

// Show a generic message plus a reference ID; log details for debugging.
export function reportError(err, context = 'Something went wrong') {
  const raw = (err && (err.message || err.error_description || err.msg)) || String(err);
  const known = Object.keys(KNOWN).find((k) => raw.includes(k));
  if (known) { toast(KNOWN[known], true); return; }
  const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
  console.error(`[ref ${ref}] ${context}:`, err);
  toast(`${context}. Please try again. (Ref ${ref})`, true);
}

export function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-CA', withTime
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  if (hh) return `${hh}h ${mm}m`;
  if (mm) return `${mm}m ${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}

export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60), ss = s % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

export function pct(score, total) {
  if (score == null || !total) return '—';
  return `${score}/${total} (${Math.round((100 * score) / total)}%)`;
}

// Status of an assignment from its attempt (if any).
export function statusOf(assignment, attempt) {
  if (attempt && attempt.submitted_at) return { key: 'done', label: 'Submitted' };
  const overdue = assignment.due_at && new Date(assignment.due_at) < new Date();
  if (attempt) return overdue ? { key: 'late', label: 'In progress · overdue' } : { key: 'progress', label: 'In progress' };
  return overdue ? { key: 'late', label: 'Overdue' } : { key: 'todo', label: 'Not started' };
}

export function pill(status) {
  return h('span', { class: `pill ${status.key}` }, status.label);
}

export function kindPill(kind) {
  return h('span', { class: `pill ${kind === 'test' ? 'test' : 'hw'}` }, kind === 'test' ? 'Test' : 'Homework');
}

export function confirmDialog(message) {
  return window.confirm(message);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Normalize a typed answer the same way the server does.
export function normAnswer(v) {
  return (v || '').toUpperCase().replace(/\s+/g, '');
}

export function isValidAnswer(v) {
  const s = normAnswer(v);
  return s === '' || /^[A-D]$/.test(s) || (/^-?[0-9./]+$/.test(s) && s.length <= 12);
}
