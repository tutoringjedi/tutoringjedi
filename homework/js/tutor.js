// Tutor dashboard: progress, students, library (PDFs + answer keys), assigning, review.
import {
  h, mount, toast, reportError, fmtDate, fmtDuration, pct, statusOf, pill, kindPill, confirmDialog,
} from './ui.js';
import { sb, q, rpc, portalUrl, signedUrl, uuid, safeName } from './db.js';
import { pdfViewer } from './pdfview.js';

export async function render(app, parts) {
  const [page, id] = parts;
  switch (page) {
    case undefined: return progressView(app);
    case 'students': return studentsView(app);
    case 'student': return studentDetailView(app, id);
    case 'library': return libraryView(app);
    case 'material': return materialView(app, id);
    case 'assign': return assignView(app, id);
    case 'review': return reviewView(app, id);
    default: location.hash = '#/';
  }
}

const one = (x) => (Array.isArray(x) ? x[0] || null : x || null);

// Seconds spent per attempt, from section start/finish times.
async function timeSpent(attemptIds) {
  if (!attemptIds.length) return {};
  const rows = await q(sb.from('attempt_sections').select('attempt_id, started_at, finished_at').in('attempt_id', attemptIds));
  const out = {};
  for (const r of rows) {
    const end = r.finished_at ? new Date(r.finished_at) : new Date();
    out[r.attempt_id] = (out[r.attempt_id] || 0) + (end - new Date(r.started_at)) / 1000;
  }
  return out;
}

async function loadAssignments(filter = {}) {
  let query = sb.from('assignments')
    .select('id, due_at, timed, note, assigned_at, student:students(id, full_name, email), material:materials(id, title, kind), attempt:attempts(id, started_at, submitted_at, score, total)')
    .order('assigned_at', { ascending: false });
  if (filter.student) query = query.eq('student_id', filter.student);
  const rows = await q(query);
  rows.forEach((r) => { r.attempt = one(r.attempt); r.student = one(r.student); r.material = one(r.material); });
  const spent = await timeSpent(rows.filter((r) => r.attempt).map((r) => r.attempt.id));
  rows.forEach((r) => { r.spent = r.attempt ? spent[r.attempt.id] : null; });
  return rows;
}

function assignmentsTable(rows, { showStudent = true } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, 'No assignments yet. ', h('a', { href: '#/assign' }, 'Assign work'), '.');
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      showStudent && h('th', {}, 'Student'), h('th', {}, 'Assignment'), h('th', {}, 'Type'),
      h('th', {}, 'Due'), h('th', {}, 'Status'), h('th', {}, 'Score'), h('th', {}, 'Time spent'))),
    h('tbody', {}, rows.map((r) => h('tr', {
      class: 'clickable', tabindex: 0,
      onclick: () => { location.hash = `#/review/${r.id}`; },
      onkeydown: (e) => { if (e.key === 'Enter') location.hash = `#/review/${r.id}`; },
    },
      showStudent && h('td', {}, r.student ? r.student.full_name : '—'),
      h('td', {}, r.material ? r.material.title : '—', r.timed ? h('span', { class: 'muted small' }, ' · timed') : ''),
      h('td', {}, r.material ? kindPill(r.material.kind) : ''),
      h('td', {}, fmtDate(r.due_at)),
      h('td', {}, pill(statusOf(r, r.attempt))),
      h('td', {}, r.attempt && r.attempt.submitted_at ? pct(r.attempt.score, r.attempt.total) : '—'),
      h('td', {}, r.spent ? fmtDuration(r.spent) : '—'),
    ))),
  ));
}

// ---------------- Progress (home) ----------------

async function progressView(app) {
  const [rows, students] = await Promise.all([
    loadAssignments(),
    q(sb.from('students').select('id, full_name').eq('active', true).order('full_name')),
  ]);
  const studentSel = h('select', { 'aria-label': 'Filter by student' },
    h('option', { value: '' }, 'All students'), students.map((s) => h('option', { value: s.id }, s.full_name)));
  const statusSel = h('select', { 'aria-label': 'Filter by status' },
    h('option', { value: '' }, 'All statuses'),
    [['todo', 'Not started'], ['progress', 'In progress'], ['late', 'Overdue'], ['done', 'Submitted']].map(([v, l]) => h('option', { value: v }, l)));
  const tableBox = h('div');
  const draw = () => {
    const f = rows.filter((r) => (!studentSel.value || (r.student && r.student.id === studentSel.value))
      && (!statusSel.value || statusOf(r, r.attempt).key === statusSel.value));
    mount(tableBox, assignmentsTable(f));
  };
  studentSel.onchange = draw; statusSel.onchange = draw;

  const submitted = rows.filter((r) => r.attempt && r.attempt.submitted_at);
  const avg = submitted.filter((r) => r.attempt.total).map((r) => r.attempt.score / r.attempt.total);
  const recent = submitted.filter((r) => Date.now() - new Date(r.attempt.submitted_at) < 7 * 864e5).length;
  mount(app,
    h('div', { class: 'page-head' }, h('h1', {}, 'Progress'), h('a', { class: 'btn gold', href: '#/assign' }, '+ Assign work')),
    h('div', { class: 'stats' },
      stat(students.length, 'Active students'),
      stat(rows.filter((r) => !r.attempt || !r.attempt.submitted_at).length, 'Open assignments'),
      stat(rows.filter((r) => statusOf(r, r.attempt).key === 'late').length, 'Overdue'),
      stat(recent, 'Submitted this week'),
      stat(avg.length ? `${Math.round((100 * avg.reduce((a, b) => a + b, 0)) / avg.length)}%` : '—', 'Average score'),
    ),
    h('div', { class: 'row', style: 'margin-bottom:.75rem' }, h('div', { style: 'flex:1 1 200px' }, studentSel), h('div', { style: 'flex:1 1 200px' }, statusSel)),
    tableBox,
  );
  draw();
}

function stat(n, l) { return h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l)); }

// ---------------- Students ----------------

function inviteText(s) {
  return `Hi ${s.full_name.split(' ')[0]}, your Tutoring Jedi homework is in the Student Portal: ${portalUrl()}\n`
    + `Sign in with this email address: ${s.email}. You'll get a sign-in link by email, no password needed.`;
}

async function sendSignIn(s) {
  try {
    const { error } = await sb.auth.signInWithOtp({ email: s.email, options: { emailRedirectTo: portalUrl() } });
    if (error) throw error;
    toast(`Sign-in email sent to ${s.email}.`);
  } catch (err) {
    if (err && err.status === 429) toast('Email limit reached. Wait a minute, or copy the invite instead.', true);
    else reportError(err, "Couldn't send the email");
  }
}

async function copyInvite(s) {
  try { await navigator.clipboard.writeText(inviteText(s)); toast('Invite message copied. Paste it into a text or email.'); }
  catch { window.prompt('Copy this invite message:', inviteText(s)); }
}

async function studentsView(app) {
  const [students, asg] = await Promise.all([
    q(sb.from('students').select('*').order('active', { ascending: false }).order('full_name')),
    q(sb.from('assignments').select('student_id, attempt:attempts(submitted_at, score, total)')),
  ]);
  const by = {};
  for (const a of asg) {
    const at = one(a.attempt);
    const s = (by[a.student_id] ||= { n: 0, done: 0, sc: [] });
    s.n++;
    if (at && at.submitted_at) { s.done++; if (at.total) s.sc.push(at.score / at.total); }
  }

  const name = h('input', { type: 'text', id: 'sname', required: true, maxlength: 120, placeholder: 'First and last name' });
  const email = h('input', { type: 'email', id: 'semail', required: true, placeholder: 'student@example.com' });
  const notes = h('input', { type: 'text', id: 'snotes', placeholder: 'Optional, e.g. target score, test date' });
  async function add(e) {
    e.preventDefault();
    try {
      const s = await q(sb.from('students').insert({ full_name: name.value.trim(), email: email.value.trim().toLowerCase(), notes: notes.value.trim() || null }).select().single());
      toast(`${s.full_name} added.`);
      studentsView(app);
    } catch (err) {
      if (err && err.code === '23505') toast('A student with that email already exists.', true);
      else reportError(err, "Couldn't add the student");
    }
  }

  mount(app,
    h('div', { class: 'page-head' }, h('h1', {}, 'Students')),
    h('div', { class: 'card', style: 'margin-bottom:1rem' },
      h('h2', {}, 'Add a student'),
      h('form', { onsubmit: add },
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: 'sname' }, 'Name'), name),
          h('div', { class: 'field' }, h('label', { for: 'semail' }, 'Email (they sign in with this)'), email)),
        h('div', { class: 'field' }, h('label', { for: 'snotes' }, 'Notes (only you see these)'), notes),
        h('button', { class: 'btn', type: 'submit' }, 'Add student')),
    ),
    students.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Done'), h('th', {}, 'Avg score'), h('th', {}, 'Invite'), h('th', {}, ''))),
      h('tbody', {}, students.map((s) => {
        const st = by[s.id] || { n: 0, done: 0, sc: [] };
        return h('tr', {},
          h('td', {}, h('a', { href: `#/student/${s.id}` }, s.full_name), s.active ? '' : h('span', { class: 'muted small' }, ' (inactive)')),
          h('td', { class: 'small' }, s.email),
          h('td', {}, `${st.done}/${st.n}`),
          h('td', {}, st.sc.length ? `${Math.round((100 * st.sc.reduce((a, b) => a + b, 0)) / st.sc.length)}%` : '—'),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => sendSignIn(s) }, 'Email sign-in link'),
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => copyInvite(s) }, 'Copy invite'))),
          h('td', {}, h('a', { class: 'btn sm', href: `#/assign/${s.id}` }, 'Assign')),
        );
      })),
    )) : h('div', { class: 'empty' }, 'No students yet.'),
  );
}

async function studentDetailView(app, id) {
  const s = await q(sb.from('students').select('*').eq('id', id).single());
  const rows = await loadAssignments({ student: id });
  const nameIn = h('input', { type: 'text', value: s.full_name, maxlength: 120, 'aria-label': 'Name' });
  const notesIn = h('textarea', { 'aria-label': 'Notes' }, s.notes || '');

  async function save() {
    try {
      await q(sb.from('students').update({ full_name: nameIn.value.trim(), notes: notesIn.value.trim() || null }).eq('id', id));
      toast('Saved.');
    } catch (err) { reportError(err, "Couldn't save"); }
  }
  async function toggleActive() {
    try {
      await q(sb.from('students').update({ active: !s.active }).eq('id', id));
      toast(s.active ? 'Student deactivated: they can no longer sign in to see work.' : 'Student reactivated.');
      studentDetailView(app, id);
    } catch (err) { reportError(err, "Couldn't update"); }
  }
  async function remove() {
    if (!confirmDialog(`Delete ${s.full_name} and all their assignments, answers and uploads? This can't be undone.`)) return;
    try {
      const atts = rows.filter((r) => r.attempt).map((r) => r.attempt.id);
      if (atts.length) {
        const ups = await q(sb.from('uploads').select('path').in('attempt_id', atts));
        if (ups.length) await q(sb.storage.from('work').remove(ups.map((u) => u.path)));
      }
      await q(sb.from('students').delete().eq('id', id));
      toast('Student deleted.');
      location.hash = '#/students';
    } catch (err) { reportError(err, "Couldn't delete the student"); }
  }

  const done = rows.filter((r) => r.attempt && r.attempt.submitted_at && r.attempt.total);
  mount(app,
    h('div', { class: 'page-head' }, h('h1', {}, s.full_name),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => sendSignIn(s) }, 'Email sign-in link'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => copyInvite(s) }, 'Copy invite'),
        h('a', { class: 'btn gold', href: `#/assign/${id}` }, '+ Assign work'))),
    h('div', { class: 'stats' },
      stat(rows.length, 'Assigned'),
      stat(done.length, 'Submitted'),
      stat(rows.filter((r) => statusOf(r, r.attempt).key === 'late').length, 'Overdue'),
      stat(done.length ? `${Math.round((100 * done.reduce((a, r) => a + r.attempt.score / r.attempt.total, 0)) / done.length)}%` : '—', 'Average score'),
      stat(fmtDuration(rows.reduce((a, r) => a + (r.spent || 0), 0)), 'Total time on work'),
    ),
    h('h2', {}, 'Assignments'),
    assignmentsTable(rows, { showStudent: false }),
    h('div', { class: 'card', style: 'margin-top:1.25rem' },
      h('h2', {}, 'Details'),
      h('p', { class: 'small muted' }, `Signs in with ${s.email}`),
      h('div', { class: 'field' }, h('label', {}, 'Name'), nameIn),
      h('div', { class: 'field' }, h('label', {}, 'Notes (only you see these)'), notesIn),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: save }, 'Save'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: toggleActive }, s.active ? 'Deactivate' : 'Reactivate'),
        h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Delete student'))),
  );
}

// ---------------- Library ----------------

const PRESETS = {
  homework: { label: 'Homework / practice set (1 section, untimed)', kind: 'homework', sections: (n) => [{ name: 'Questions', question_count: n, time_limit_minutes: null }] },
  sat_full: {
    label: 'Full digital SAT practice test (4 timed modules)', kind: 'test', sections: () => [
      { name: 'Reading & Writing · Module 1', question_count: 27, time_limit_minutes: 32 },
      { name: 'Reading & Writing · Module 2', question_count: 27, time_limit_minutes: 32 },
      { name: 'Math · Module 1', question_count: 22, time_limit_minutes: 35 },
      { name: 'Math · Module 2', question_count: 22, time_limit_minutes: 35 }],
  },
  sat_rw: {
    label: 'SAT Reading & Writing section (2 timed modules)', kind: 'test', sections: () => [
      { name: 'Reading & Writing · Module 1', question_count: 27, time_limit_minutes: 32 },
      { name: 'Reading & Writing · Module 2', question_count: 27, time_limit_minutes: 32 }],
  },
  sat_math: {
    label: 'SAT Math section (2 timed modules)', kind: 'test', sections: () => [
      { name: 'Math · Module 1', question_count: 22, time_limit_minutes: 35 },
      { name: 'Math · Module 2', question_count: 22, time_limit_minutes: 35 }],
  },
};

async function libraryView(app) {
  const [mats, secs, keys, asg] = await Promise.all([
    q(sb.from('materials').select('*').order('created_at', { ascending: false })),
    q(sb.from('material_sections').select('id, material_id, question_count')),
    q(sb.from('answer_keys').select('section_id, correct')),
    q(sb.from('assignments').select('material_id')),
  ]);
  const keyed = {};
  keys.forEach((k) => { if (k.correct && k.correct.length) keyed[k.section_id] = (keyed[k.section_id] || 0) + 1; });
  const info = {};
  secs.forEach((s) => {
    const i = (info[s.material_id] ||= { q: 0, k: 0, n: 0 });
    i.q += s.question_count; i.k += keyed[s.id] || 0; i.n++;
  });
  const assigned = {};
  asg.forEach((a) => { assigned[a.material_id] = (assigned[a.material_id] || 0) + 1; });

  const files = h('input', { type: 'file', id: 'pdfs', accept: 'application/pdf', multiple: true, required: true });
  const preset = h('select', { id: 'preset' }, Object.entries(PRESETS).map(([k, p]) => h('option', { value: k }, p.label)));
  const count = h('input', { type: 'number', id: 'qcount', min: 1, max: 200, value: 20 });
  const countField = h('div', { class: 'field' }, h('label', { for: 'qcount' }, 'Number of questions'), count);
  preset.onchange = () => { countField.hidden = preset.value !== 'homework'; };
  const progress = h('p', { class: 'small muted' });
  const upBtn = h('button', { class: 'btn', type: 'submit' }, 'Upload');
  const search = h('input', { type: 'search', placeholder: 'Search the library…', 'aria-label': 'Search the library' });
  const listBox = h('div');

  async function upload(e) {
    e.preventDefault();
    const list = [...files.files];
    if (!list.length) return;
    const p = PRESETS[preset.value];
    upBtn.disabled = true;
    let ok = 0;
    for (const [i, f] of list.entries()) {
      progress.textContent = `Uploading ${i + 1} of ${list.length}: ${f.name}`;
      try {
        if (f.type !== 'application/pdf') throw new Error('Not a PDF');
        const path = `${uuid()}/${safeName(f.name)}`;
        await q(sb.storage.from('materials').upload(path, f, { contentType: 'application/pdf', upsert: false }));
        const title = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) || 'Untitled';
        const m = await q(sb.from('materials').insert({ title, kind: p.kind, pdf_path: path }).select().single());
        const n = Math.min(200, Math.max(1, Number(count.value) || 20));
        await q(sb.from('material_sections').insert(p.sections(n).map((s, idx) => ({ ...s, position: idx + 1, material_id: m.id }))));
        ok++;
      } catch (err) { reportError(err, `Couldn't upload ${f.name}`); }
    }
    upBtn.disabled = false;
    toast(`${ok} of ${list.length} PDF${list.length === 1 ? '' : 's'} added. Add answer keys so they can be auto-graded.`);
    libraryView(app);
  }

  const draw = () => {
    const term = search.value.trim().toLowerCase();
    const f = mats.filter((m) => !term || m.title.toLowerCase().includes(term));
    mount(listBox, f.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Type'), h('th', {}, 'Questions'), h('th', {}, 'Answer key'), h('th', {}, 'Assigned'), h('th', {}, ''))),
      h('tbody', {}, f.map((m) => {
        const i = info[m.id] || { q: 0, k: 0, n: 0 };
        const keyPill = i.q && i.k >= i.q ? h('span', { class: 'pill done' }, 'Complete')
          : i.k ? h('span', { class: 'pill progress' }, `${i.k}/${i.q}`) : h('span', { class: 'pill late' }, 'Missing');
        return h('tr', { class: 'clickable', onclick: (e) => { if (e.target.tagName !== 'A') location.hash = `#/material/${m.id}`; } },
          h('td', {}, h('a', { href: `#/material/${m.id}` }, m.title)),
          h('td', {}, kindPill(m.kind)),
          h('td', {}, `${i.q}${i.n > 1 ? ` in ${i.n} sections` : ''}`),
          h('td', {}, keyPill),
          h('td', {}, String(assigned[m.id] || 0)),
          h('td', {}, h('a', { class: 'btn sm', href: `#/assign?m=${m.id}`, onclick: (e) => { e.stopPropagation(); sessionStorage.setItem('hw_pick_material', m.id); location.hash = '#/assign'; e.preventDefault(); } }, 'Assign')));
      })))) : h('div', { class: 'empty' }, mats.length ? 'No matches.' : 'Your library is empty. Upload PDFs above.'));
  };
  search.oninput = draw;

  mount(app,
    h('div', { class: 'page-head' }, h('h1', {}, 'Library')),
    h('div', { class: 'card', style: 'margin-bottom:1rem' },
      h('h2', {}, 'Upload PDFs'),
      h('p', { class: 'small muted' }, 'Select one or many PDFs. Each becomes its own assignment you can reuse. Files stay private: only students you assign them to can open them.'),
      h('form', { onsubmit: upload },
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: 'pdfs' }, 'PDF files'), files),
          h('div', { class: 'field' }, h('label', { for: 'preset' }, 'Format'), preset)),
        countField,
        h('div', { class: 'row' }, upBtn, progress))),
    h('div', { class: 'field' }, search),
    listBox,
  );
  draw();
}

// Parse a pasted answer key. Supports "1. B", "1) B", "1: 3/4|.75" lines, or "B D A C" in order.
export function parseKey(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numbered = /^(\d{1,3})\s*[.):\-]\s*(\S+)/;
  const numberedLetter = /^(\d{1,3})\s+([A-Da-d])$/;
  const out = {};
  const pairs = [];
  if (lines.length && lines.filter((l) => numbered.test(l) || numberedLetter.test(l)).length >= lines.length * 0.6) {
    for (const l of lines) {
      const m = l.match(numbered) || l.match(numberedLetter);
      if (m) pairs.push([Number(m[1]), m[2]]);
    }
  } else {
    // Inline numbered "1.B 2.C" or plain sequence "B C D".
    const inline = [...text.matchAll(/(\d{1,3})\s*[.):]\s*([A-Da-d]\b|-?[0-9./|]+)/g)];
    if (inline.length >= 2) inline.forEach((m) => pairs.push([Number(m[1]), m[2]]));
    else text.split(/[\s,;]+/).filter(Boolean).forEach((t, i) => pairs.push([i + 1, t]));
  }
  for (const [n, v] of pairs) if (n >= 1 && n <= 200) out[n] = v.toUpperCase();
  return out;
}

function keyToRow(value) {
  const correct = String(value || '').toUpperCase().split('|').map((s) => s.replace(/\s+/g, '')).filter(Boolean);
  const qtype = correct.length && correct.every((c) => /^[A-D]$/.test(c)) ? 'mc' : (correct.length ? 'grid' : 'mc');
  return { correct, qtype };
}

async function materialView(app, id) {
  const [m, secs] = await Promise.all([
    q(sb.from('materials').select('*').eq('id', id).single()),
    q(sb.from('material_sections').select('*').eq('material_id', id).order('position')),
  ]);
  const keys = secs.length ? await q(sb.from('answer_keys').select('*').in('section_id', secs.map((s) => s.id))) : [];
  const keyMap = {};
  keys.forEach((k) => { (keyMap[k.section_id] ||= {})[k.question_no] = { value: k.correct.join('|'), qtype: k.qtype }; });

  const title = h('input', { type: 'text', value: m.title, maxlength: 200, id: 'mtitle' });
  const kind = h('select', { id: 'mkind' }, h('option', { value: 'homework' }, 'Homework'), h('option', { value: 'test' }, 'Test'));
  kind.value = m.kind;
  const desc = h('textarea', { id: 'mdesc', placeholder: 'Instructions shown to the student (optional)' }, m.description || '');
  const showAns = h('input', { type: 'checkbox', id: 'mshow', checked: m.show_answers_after });

  // Section editors keep their own state.
  const sections = secs.map((s) => ({ ...s, keys: { ...(keyMap[s.id] || {}) } }));
  const secBox = h('div');

  function sectionEditor(s, idx) {
    const name = h('input', { type: 'text', value: s.name, maxlength: 80, oninput: (e) => { s.name = e.target.value; } });
    const count = h('input', { type: 'number', min: 1, max: 200, value: s.question_count });
    const mins = h('input', { type: 'number', min: 1, max: 600, value: s.time_limit_minutes || '', placeholder: 'No limit', oninput: (e) => { s.time_limit_minutes = e.target.value ? Number(e.target.value) : null; } });
    const grid = h('div', { class: 'key-grid' });
    const drawGrid = () => {
      mount(grid, Array.from({ length: s.question_count }, (_, i) => {
        const n = i + 1;
        const inp = h('input', {
          type: 'text', value: (s.keys[n] && s.keys[n].value) || '', maxlength: 60, 'aria-label': `Answer ${n}`,
          oninput: (e) => { s.keys[n] = { value: e.target.value }; },
        });
        return h('div', { class: 'key-cell' }, h('span', {}, `${n}.`), inp);
      }));
    };
    count.oninput = () => {
      const v = Math.min(200, Math.max(1, Number(count.value) || 1));
      s.question_count = v; drawGrid();
    };
    const paste = h('textarea', { placeholder: 'Paste a key, e.g.\n1. B\n2. D\n3. 3/4|.75\nor just: B D A C …', style: 'min-height:70px' });
    const applyPaste = () => {
      const parsed = parseKey(paste.value);
      const nums = Object.keys(parsed).map(Number);
      if (!nums.length) { toast("Couldn't read that key.", true); return; }
      const max = Math.max(...nums);
      if (max > s.question_count) { s.question_count = max; count.value = max; }
      nums.forEach((n) => { s.keys[n] = { value: parsed[n] }; });
      drawGrid();
      toast(`Filled ${nums.length} answers. Review, then Save.`);
    };
    drawGrid();
    return h('div', { class: 'section-edit' },
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', {}, `Section ${idx + 1} name`), name),
        h('div', { class: 'field', style: 'flex:0 1 120px' }, h('label', {}, 'Questions'), count),
        h('div', { class: 'field', style: 'flex:0 1 150px' }, h('label', {}, 'Time limit (min)'), mins),
        sections.length > 1 && h('button', { class: 'btn sm danger', type: 'button', onclick: () => { sections.splice(idx, 1); drawSections(); } }, 'Remove')),
      h('details', {}, h('summary', { class: 'small' }, 'Paste an answer key'),
        h('div', { style: 'margin-top:.5rem' }, paste, h('button', { class: 'btn sm ghost', type: 'button', style: 'margin-top:.4rem', onclick: applyPaste }, 'Fill answers'))),
      h('p', { class: 'small muted', style: 'margin:.6rem 0 .4rem' }, 'Answer key: A–D for multiple choice, or a number for grid-in (3/4, .75, -2). Separate extra accepted answers with | (e.g. 2/3|.6666|.6667). Leave blank for ungraded.'),
      grid,
    );
  }
  function drawSections() { mount(secBox, sections.map(sectionEditor)); }
  drawSections();

  async function save() {
    try {
      for (const s of sections) {
        for (const [n, k] of Object.entries(s.keys)) {
          if (Number(n) > s.question_count) continue;
          const { correct } = keyToRow(k.value);
          if (correct.some((c) => !/^[A-D]$/.test(c) && !/^-?[0-9./]+$/.test(c))) {
            toast(`Check ${s.name} question ${n}: use A–D or a number.`, true); return;
          }
        }
      }
      await q(sb.from('materials').update({
        title: title.value.trim() || m.title, kind: kind.value, description: desc.value.trim() || null, show_answers_after: showAns.checked,
      }).eq('id', id));
      const keepIds = sections.filter((s) => s.id).map((s) => s.id);
      const removed = secs.filter((s) => !keepIds.includes(s.id)).map((s) => s.id);
      if (removed.length) await q(sb.from('material_sections').delete().in('id', removed));
      // Positions: shift existing ones out of the way first to avoid unique clashes.
      for (const s of sections.filter((x) => x.id)) await q(sb.from('material_sections').update({ position: 1000 + s.position }).eq('id', s.id));
      for (const [i, s] of sections.entries()) {
        const row = { material_id: id, position: i + 1, name: (s.name || `Section ${i + 1}`).trim(), question_count: s.question_count, time_limit_minutes: s.time_limit_minutes || null };
        if (s.id) await q(sb.from('material_sections').update(row).eq('id', s.id));
        else s.id = (await q(sb.from('material_sections').insert(row).select().single())).id;
        const rows = Object.entries(s.keys)
          .filter(([n]) => Number(n) <= s.question_count)
          .map(([n, k]) => ({ section_id: s.id, question_no: Number(n), ...keyToRow(k.value) }))
          .filter((r) => r.correct.length);
        await q(sb.from('answer_keys').delete().eq('section_id', s.id));
        if (rows.length) await q(sb.from('answer_keys').insert(rows));
      }
      toast('Saved.');
      materialView(app, id);
    } catch (err) { reportError(err, "Couldn't save"); }
  }

  async function remove() {
    if (!confirmDialog(`Delete "${m.title}"? It will also be removed from every student it was assigned to, with their answers.`)) return;
    try {
      if (m.pdf_path) await q(sb.storage.from('materials').remove([m.pdf_path]));
      await q(sb.from('materials').delete().eq('id', id));
      toast('Deleted.');
      location.hash = '#/library';
    } catch (err) { reportError(err, "Couldn't delete"); }
  }

  async function replacePdf(e) {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const path = `${uuid()}/${safeName(f.name)}`;
      await q(sb.storage.from('materials').upload(path, f, { contentType: 'application/pdf' }));
      await q(sb.from('materials').update({ pdf_path: path }).eq('id', id));
      if (m.pdf_path) await sb.storage.from('materials').remove([m.pdf_path]);
      toast('PDF replaced.');
      materialView(app, id);
    } catch (err) { reportError(err, "Couldn't replace the PDF"); }
  }

  const previewBox = h('div');
  async function preview() {
    try {
      const url = await signedUrl('materials', m.pdf_path, 1800);
      const pane = h('div', { class: 'pdf-pane', style: 'height:70vh;border-radius:10px;margin-top:.75rem' });
      mount(previewBox, pane);
      pane.append(pdfViewer(url));
    } catch (err) { reportError(err, "Couldn't open the PDF"); }
  }

  mount(app,
    h('div', { class: 'page-head' }, h('h1', {}, m.title),
      h('div', { class: 'row' },
        h('a', { class: 'btn ghost', href: '#/library' }, '← Library'),
        h('button', { class: 'btn gold', type: 'button', onclick: () => { sessionStorage.setItem('hw_pick_material', id); location.hash = '#/assign'; } }, 'Assign'))),
    h('div', { class: 'card', style: 'margin-bottom:1rem' },
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', { for: 'mtitle' }, 'Title'), title),
        h('div', { class: 'field' }, h('label', { for: 'mkind' }, 'Type'), kind)),
      h('div', { class: 'field' }, h('label', { for: 'mdesc' }, 'Instructions'), desc),
      h('label', { class: 'check' }, showAns, 'Show correct answers to the student after they submit'),
      h('div', { class: 'row', style: 'margin-top:.75rem' },
        m.pdf_path && h('button', { class: 'btn ghost sm', type: 'button', onclick: preview }, 'Preview PDF'),
        h('label', { class: 'btn ghost sm', style: 'margin:0' }, 'Replace PDF', h('input', { type: 'file', accept: 'application/pdf', hidden: true, onchange: replacePdf }))),
      previewBox),
    h('h2', {}, 'Sections & answer key'),
    secBox,
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { sections.push({ name: `Section ${sections.length + 1}`, question_count: 20, time_limit_minutes: null, keys: {} }); drawSections(); } }, '+ Add section'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Delete'),
      h('button', { class: 'btn', type: 'button', onclick: save }, 'Save changes')),
  );
}

// ---------------- Assign ----------------

async function assignView(app, preStudent) {
  const [mats, students] = await Promise.all([
    q(sb.from('materials').select('id, title, kind').order('title')),
    q(sb.from('students').select('id, full_name').eq('active', true).order('full_name')),
  ]);
  const preMat = sessionStorage.getItem('hw_pick_material');
  sessionStorage.removeItem('hw_pick_material');
  if (!mats.length) { mount(app, h('div', { class: 'empty' }, 'Upload PDFs to your ', h('a', { href: '#/library' }, 'library'), ' first.')); return; }
  if (!students.length) { mount(app, h('div', { class: 'empty' }, 'Add ', h('a', { href: '#/students' }, 'students'), ' first.')); return; }

  const matFilter = h('input', { type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter materials' });
  const matChecks = mats.map((m) => ({ m, box: h('input', { type: 'checkbox', checked: m.id === preMat }) }));
  const stuChecks = students.map((s) => ({ s, box: h('input', { type: 'checkbox', checked: s.id === preStudent }) }));
  const matList = h('div', { style: 'max-height:320px;overflow:auto' });
  const drawMats = () => {
    const t = matFilter.value.trim().toLowerCase();
    mount(matList, matChecks.filter(({ m }) => !t || m.title.toLowerCase().includes(t))
      .map(({ m, box }) => h('label', { class: 'check', style: 'padding:.3rem 0' }, box, m.title, ' ', kindPill(m.kind))));
  };
  matFilter.oninput = drawMats;
  drawMats();

  const due = h('input', { type: 'datetime-local', id: 'due' });
  const d = new Date(Date.now() + 7 * 864e5); d.setHours(21, 0, 0, 0);
  due.value = new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const timed = h('input', { type: 'checkbox', id: 'timed' });
  const note = h('textarea', { id: 'note', placeholder: 'Optional message, e.g. "Do questions 1–15 only"' });
  const btn = h('button', { class: 'btn gold', type: 'button' }, 'Assign');

  btn.onclick = async () => {
    const ms = matChecks.filter((x) => x.box.checked).map((x) => x.m.id);
    const ss = stuChecks.filter((x) => x.box.checked).map((x) => x.s.id);
    if (!ms.length || !ss.length) { toast('Pick at least one item and one student.', true); return; }
    const rows = [];
    for (const material_id of ms) for (const student_id of ss) {
      rows.push({ material_id, student_id, due_at: due.value ? new Date(due.value).toISOString() : null, timed: timed.checked, note: note.value.trim() || null });
    }
    btn.disabled = true;
    try {
      await q(sb.from('assignments').insert(rows));
      toast(`${rows.length} assignment${rows.length === 1 ? '' : 's'} created. Students see them next time they sign in.`);
      location.hash = '#/';
    } catch (err) { reportError(err, "Couldn't assign"); btn.disabled = false; }
  };

  mount(app,
    h('div', { class: 'page-head' }, h('h1', {}, 'Assign work')),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', {}, '1. What'), matFilter, matList),
      h('div', { class: 'card' }, h('h2', {}, '2. Who'),
        h('label', { class: 'check', style: 'padding:.3rem 0;color:var(--muted)' },
          h('input', { type: 'checkbox', onchange: (e) => stuChecks.forEach((x) => { x.box.checked = e.target.checked; }) }), 'Select all'),
        stuChecks.map(({ s, box }) => h('label', { class: 'check', style: 'padding:.3rem 0' }, box, s.full_name)))),
    h('div', { class: 'card', style: 'margin-top:1rem' },
      h('h2', {}, '3. Details'),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', { for: 'due' }, 'Due'), due),
        h('div', { class: 'field' }, h('label', {}, 'Timing'),
          h('label', { class: 'check' }, timed, 'Timed: enforce each section’s time limit'))),
      h('div', { class: 'field' }, h('label', { for: 'note' }, 'Note to student'), note),
      btn),
  );
}

// ---------------- Review a student's work ----------------

async function reviewView(app, id) {
  const a = await q(sb.from('assignments')
    .select('*, student:students(id, full_name, email), material:materials(*), attempt:attempts(*)').eq('id', id).single());
  a.attempt = one(a.attempt); a.student = one(a.student); a.material = one(a.material);
  const secs = await q(sb.from('material_sections').select('*').eq('material_id', a.material.id).order('position'));
  const at = a.attempt;
  let results = [], times = [], uploads = [];
  if (at) {
    [results, times, uploads] = await Promise.all([
      rpc('attempt_results', { p_attempt: at.id }),
      q(sb.from('attempt_sections').select('*').eq('attempt_id', at.id)),
      q(sb.from('uploads').select('*').eq('attempt_id', at.id).order('created_at')),
    ]);
  }
  const status = statusOf(a, at);

  const fb = h('textarea', { id: 'fb', placeholder: 'Feedback the student will see' }, (at && at.tutor_feedback) || '');
  async function saveFeedback() {
    try { await q(sb.from('attempts').update({ tutor_feedback: fb.value.trim() || null }).eq('id', at.id)); toast('Feedback saved.'); }
    catch (err) { reportError(err, "Couldn't save feedback"); }
  }
  async function regrade() {
    try { await rpc('regrade_attempt', { p_attempt: at.id }); toast('Re-graded with the current answer key.'); reviewView(app, id); }
    catch (err) { reportError(err, "Couldn't re-grade"); }
  }
  async function reopen() {
    if (!confirmDialog('Reopen this assignment? The student can change answers and submit again. Timed sections whose time already ran out stay locked; use "Clear answers" for a full retake.')) return;
    try {
      await q(sb.from('attempts').update({ submitted_at: null }).eq('id', at.id));
      await q(sb.from('attempt_sections').update({ finished_at: null }).eq('attempt_id', at.id));
      toast('Reopened.'); reviewView(app, id);
    } catch (err) { reportError(err, "Couldn't reopen"); }
  }
  async function reset() {
    if (!confirmDialog('Clear all of this student’s answers and uploads for this assignment so they can start fresh?')) return;
    try {
      if (uploads.length) await q(sb.storage.from('work').remove(uploads.map((u) => u.path)));
      await q(sb.from('attempts').delete().eq('id', at.id));
      toast('Cleared.'); reviewView(app, id);
    } catch (err) { reportError(err, "Couldn't clear"); }
  }
  async function unassign() {
    if (!confirmDialog('Remove this assignment from the student (including any answers)?')) return;
    try {
      if (uploads.length) await q(sb.storage.from('work').remove(uploads.map((u) => u.path)));
      await q(sb.from('assignments').delete().eq('id', id));
      toast('Assignment removed.'); location.hash = '#/';
    } catch (err) { reportError(err, "Couldn't remove"); }
  }

  const bySec = {};
  results.forEach((r) => { (bySec[r.section_id] ||= []).push(r); });
  const tBySec = {};
  times.forEach((t) => { tBySec[t.section_id] = t; });

  const upBox = h('div', { class: 'uploads' });
  (async () => {
    for (const u of uploads) {
      try {
        const url = await signedUrl('work', u.path, 3600);
        const isImg = /\.(jpe?g|png|webp|gif)$/i.test(u.path);
        upBox.append(h('a', { href: url, target: '_blank', rel: 'noopener', title: fmtDate(u.created_at) },
          isImg ? h('img', { src: url, alt: 'Student work' }) : h('div', { class: 'file' }, u.path.split('/').pop())));
      } catch (err) { console.error(err); }
    }
  })();

  mount(app,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, a.material.title), h('p', { class: 'muted', style: 'margin:0' },
        h('a', { href: `#/student/${a.student.id}` }, a.student.full_name), ` · assigned ${fmtDate(a.assigned_at)} · due ${fmtDate(a.due_at)}${a.timed ? ' · timed' : ''}`)),
      pill(status)),
    h('div', { class: 'stats' },
      stat(at && at.submitted_at ? pct(at.score, at.total) : '—', 'Score'),
      stat(at ? fmtDate(at.started_at) : '—', 'Started'),
      stat(at && at.submitted_at ? fmtDate(at.submitted_at) : '—', 'Submitted'),
      stat(fmtDuration(times.reduce((s, t) => s + ((t.finished_at ? new Date(t.finished_at) : new Date()) - new Date(t.started_at)) / 1000, 0) || null), 'Time spent'),
    ),
    a.note && h('p', { class: 'notice small' }, `Note to student: ${a.note}`),
    !at && h('div', { class: 'empty' }, 'The student hasn’t opened this yet.'),
    at && secs.map((s) => {
      const rs = (bySec[s.id] || []);
      const t = tBySec[s.id];
      const right = rs.filter((r) => r.is_correct).length;
      const graded = rs.filter((r) => r.is_correct !== null).length;
      return h('div', { class: 'card', style: 'margin-bottom:1rem' },
        h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, s.name), h('span', { class: 'spacer' }),
          h('span', { class: 'small muted' },
            t ? `${fmtDuration(((t.finished_at ? new Date(t.finished_at) : new Date()) - new Date(t.started_at)) / 1000)}${s.time_limit_minutes ? ` of ${s.time_limit_minutes} min` : ''}` : 'Not started',
            at.submitted_at && graded ? ` · ${right}/${graded} correct` : '')),
        rs.length ? h('div', { class: 'table-wrap', style: 'margin-top:.6rem' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Answer'), h('th', {}, 'Correct'), h('th', {}, ''))),
          h('tbody', {}, rs.map((r) => h('tr', { class: 'res-row' },
            h('td', {}, String(r.question_no)),
            h('td', {}, r.answer || '—'),
            h('td', {}, (r.correct || []).join(' or ') || '—'),
            h('td', { class: r.is_correct === true ? 'ok' : r.is_correct === false ? 'bad' : '' },
              r.is_correct === true ? '✓' : r.is_correct === false ? '✗' : (at.submitted_at ? 'not graded' : '')))))))
          : h('p', { class: 'small muted' }, 'No answers yet.'));
    }),
    at && h('div', { class: 'card', style: 'margin-bottom:1rem' }, h('h3', {}, 'Uploaded work'),
      uploads.length ? upBox : h('p', { class: 'small muted' }, 'No photos uploaded.')),
    at && h('div', { class: 'card', style: 'margin-bottom:1rem' }, h('h3', {}, 'Feedback'),
      fb, h('button', { class: 'btn', type: 'button', style: 'margin-top:.5rem', onclick: saveFeedback }, 'Save feedback')),
    h('div', { class: 'row' },
      at && at.submitted_at && h('button', { class: 'btn ghost', type: 'button', onclick: regrade }, 'Re-grade'),
      at && at.submitted_at && h('button', { class: 'btn ghost', type: 'button', onclick: reopen }, 'Reopen for student'),
      at && h('button', { class: 'btn ghost', type: 'button', onclick: reset }, 'Clear answers'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger', type: 'button', onclick: unassign }, 'Remove assignment')),
  );
}
