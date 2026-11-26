// Student portal: assignment list, workspace (PDF + answer sheet), results.
import {
  h, mount, toast, reportError, fmtDate, fmtClock, fmtDuration, pct, statusOf, pill, kindPill,
  confirmDialog, normAnswer, isValidAnswer,
} from './ui.js';
import { sb, q, rpc, signedUrl, safeName } from './db.js';
import { pdfViewer } from './pdfview.js';

const one = (x) => (Array.isArray(x) ? x[0] || null : x || null);
let cleanup = [];
function runCleanup() { cleanup.forEach((f) => f()); cleanup = []; }
window.addEventListener('hashchange', runCleanup);

export async function render(app, parts, state) {
  runCleanup();
  const [page, id] = parts;
  if (page === 'do') return workView(app, id);
  if (page === 'results') return resultsView(app, id);
  return listView(app, state);
}

// ---------------- My work ----------------

async function listView(app, state) {
  const rows = await q(sb.from('assignments')
    .select('id, due_at, timed, note, assigned_at, material:materials(id, title, kind), attempt:attempts(id, started_at, submitted_at, score, total)')
    .order('due_at', { ascending: true, nullsFirst: false }));
  rows.forEach((r) => { r.attempt = one(r.attempt); r.material = one(r.material); });
  const open = rows.filter((r) => !r.attempt || !r.attempt.submitted_at);
  const done = rows.filter((r) => r.attempt && r.attempt.submitted_at)
    .sort((a, b) => new Date(b.attempt.submitted_at) - new Date(a.attempt.submitted_at));

  const card = (r) => {
    const st = statusOf(r, r.attempt);
    const href = r.attempt && r.attempt.submitted_at ? `#/results/${r.id}` : `#/do/${r.id}`;
    return h('a', { class: 'card', href, style: 'display:block;text-decoration:none;color:inherit' },
      h('div', { class: 'row' }, kindPill(r.material.kind), pill(st), r.timed && h('span', { class: 'pill progress' }, 'Timed')),
      h('h3', { style: 'margin:.6rem 0 .2rem' }, r.material.title),
      h('p', { class: 'small muted', style: 'margin:0' },
        r.attempt && r.attempt.submitted_at ? `Submitted ${fmtDate(r.attempt.submitted_at)} · Score ${pct(r.attempt.score, r.attempt.total)}` : `Due ${fmtDate(r.due_at)}`),
      r.note && h('p', { class: 'small', style: 'margin:.5rem 0 0' }, r.note));
  };

  const first = (state.me && state.me.full_name || '').split(' ')[0];
  mount(app,
    h('div', { class: 'page-head' }, h('h1', {}, first ? `Hi ${first}` : 'My work')),
    h('h2', {}, `To do (${open.length})`),
    open.length ? h('div', { class: 'grid2' }, open.map(card)) : h('div', { class: 'empty' }, 'Nothing to do right now. Nice work!'),
    done.length > 0 && h('h2', { style: 'margin-top:1.5rem' }, `Completed (${done.length})`),
    done.length > 0 && h('div', { class: 'grid2' }, done.map(card)),
  );
}

// ---------------- Doing an assignment ----------------

async function workView(app, assignmentId) {
  const a = await q(sb.from('assignments').select('*, material:materials(*)').eq('id', assignmentId).single());
  a.material = one(a.material);
  const attempt = await rpc('start_attempt', { p_assignment: assignmentId });
  if (attempt.submitted_at) { location.hash = `#/results/${assignmentId}`; return; }
  const [secs, saved, started, ups] = await Promise.all([
    q(sb.from('material_sections').select('*').eq('material_id', a.material.id).order('position')),
    rpc('my_responses', { p_attempt: attempt.id }),
    q(sb.from('attempt_sections').select('*').eq('attempt_id', attempt.id)),
    q(sb.from('uploads').select('*').eq('attempt_id', attempt.id).order('created_at')),
  ]);
  const layouts = {};
  await Promise.all(secs.map(async (s) => { layouts[s.id] = await rpc('section_layout', { p_section: s.id }); }));

  const answers = {};
  saved.forEach((r) => { (answers[r.section_id] ||= {})[r.question_no] = r.answer || ''; });
  const secState = {};
  started.forEach((t) => { secState[t.section_id] = t; });
  const flagKey = `hw_flags_${attempt.id}`;
  let flags = {};
  try { flags = JSON.parse(localStorage.getItem(flagKey) || '{}'); } catch { flags = {}; }
  const saveFlags = () => { try { localStorage.setItem(flagKey, JSON.stringify(flags)); } catch { /* ignore */ } };

  const isTimed = (s) => a.timed && s.time_limit_minutes;
  let current = (secs.find((s) => secState[s.id] && !secState[s.id].finished_at) || secs.find((s) => !secState[s.id]) || secs[0] || {}).id;

  // Workspace layout
  app.classList.add('wide');
  const pdfPane = h('div', { class: 'pdf-pane' });
  const answerPane = h('div', { class: 'answer-pane' });
  const ws = h('div', { class: 'workspace', dataset: { pane: 'answers' } });
  const tabPdf = h('button', { type: 'button', onclick: () => setPane('pdf') }, 'Questions (PDF)');
  const tabAns = h('button', { type: 'button', class: 'active', onclick: () => setPane('answers') }, 'Answer sheet');
  function setPane(p) { ws.dataset.pane = p; tabPdf.className = p === 'pdf' ? 'active' : ''; tabAns.className = p === 'answers' ? 'active' : ''; }
  ws.append(h('div', { class: 'pane-tabs' }, tabPdf, tabAns), pdfPane, answerPane);
  mount(app, ws);
  if (window.innerWidth < 860) setPane('pdf');

  if (a.material.pdf_path) {
    signedUrl('materials', a.material.pdf_path, 4 * 3600)
      .then((url) => pdfPane.append(pdfViewer(url)))
      .catch((err) => { reportError(err, "Couldn't open the PDF"); pdfPane.append(h('div', { class: 'pdf-msg' }, 'The PDF could not be loaded.')); });
  } else {
    pdfPane.append(h('div', { class: 'pdf-msg' }, 'No PDF attached to this assignment.'));
  }

  // Timer
  let timerInt = null;
  cleanup.push(() => clearInterval(timerInt));

  const body = h('div');
  const uploadsBox = h('div', { class: 'uploads' });
  const fileIn = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true, onchange: onFiles });

  async function showUpload(u) {
    try {
      const url = await signedUrl('work', u.path, 3600);
      const isImg = /\.(jpe?g|png|webp|gif)$/i.test(u.path);
      uploadsBox.append(h('a', { href: url, target: '_blank', rel: 'noopener' },
        isImg ? h('img', { src: url, alt: 'Your uploaded work' }) : h('div', { class: 'file' }, u.path.split('/').pop())));
    } catch (err) { console.error(err); }
  }
  ups.forEach(showUpload);

  async function onFiles(e) {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB.`, true); continue; }
      try {
        const path = `${attempt.id}/${Date.now()}-${safeName(f.name)}`;
        await q(sb.storage.from('work').upload(path, f, { contentType: f.type || 'image/jpeg' }));
        const u = await q(sb.from('uploads').insert({ attempt_id: attempt.id, path }).select().single());
        showUpload(u);
        toast('Photo uploaded.');
      } catch (err) { reportError(err, `Couldn't upload ${f.name}`); }
    }
  }

  function answeredCount() {
    let n = 0, total = 0;
    for (const s of secs) {
      total += s.question_count;
      n += Object.values(answers[s.id] || {}).filter(Boolean).length;
    }
    return { n, total };
  }
  const progressLine = h('p', { class: 'small muted', style: 'margin:.25rem 0 0' });
  const updateProgress = () => { const { n, total } = answeredCount(); progressLine.textContent = `${n} of ${total} answered`; };

  async function submit() {
    const { n, total } = answeredCount();
    const msg = n < total
      ? `You've answered ${n} of ${total} questions. Submit anyway? You can't change answers after submitting.`
      : "Submit your answers? You can't change them after submitting.";
    if (!confirmDialog(msg)) return;
    try {
      await rpc('submit_attempt', { p_attempt: attempt.id });
      try { localStorage.removeItem(flagKey); } catch { /* ignore */ }
      toast('Submitted!');
      location.hash = `#/results/${assignmentId}`;
    } catch (err) { reportError(err, "Couldn't submit"); }
  }

  function drawSection() {
    clearInterval(timerInt);
    const s = secs.find((x) => x.id === current);
    if (!s) { mount(body, h('p', { class: 'muted' }, 'This assignment has no questions set up yet. Let your tutor know.')); return; }
    const st = secState[s.id];
    const closed = !!(st && st.finished_at);

    if (!st) {
      mount(body, h('div', { class: 'card', style: 'text-align:center' },
        h('h3', {}, s.name),
        h('p', {}, `${s.question_count} questions`),
        isTimed(s) ? h('p', { class: 'notice' }, `Timed: you'll have ${s.time_limit_minutes} minutes once you start. The clock keeps running even if you close the page.`)
          : h('p', { class: 'muted small' }, 'Untimed. Your answers save automatically.'),
        h('button', {
          class: 'btn gold', type: 'button', onclick: async (e) => {
            e.target.disabled = true;
            try { secState[s.id] = await rpc('start_section', { p_attempt: attempt.id, p_section: s.id }); drawTabs(); drawSection(); }
            catch (err) { reportError(err, "Couldn't start the section"); e.target.disabled = false; }
          },
        }, isTimed(s) ? 'Start timer' : 'Start')));
      return;
    }

    const rows = (layouts[s.id] || []).map((lq) => questionRow(s, lq, closed));
    const timerEl = h('span', { class: 'timer' }, '');
    const finishBtn = !closed && secs.length > 1 && h('button', {
      class: 'btn sm ghost', type: 'button', onclick: async () => {
        if (!confirmDialog(`Finish ${s.name}? You won't be able to change these answers.`)) return;
        await closeSection(s);
      },
    }, 'Finish section');

    mount(body,
      (isTimed(s) || closed) && h('div', { class: 'timer-box' },
        closed ? h('strong', {}, 'Section finished · answers locked') : timerEl,
        finishBtn || ''),
      !isTimed(s) && !closed && finishBtn && h('div', { class: 'row', style: 'margin-bottom:.5rem' }, h('span', { class: 'spacer' }), finishBtn),
      rows);

    if (isTimed(s) && !closed) {
      rpc('section_seconds_left', { p_attempt: attempt.id, p_section: s.id }).then((left) => {
        const deadline = Date.now() + (left ?? 0) * 1000;
        const tick = async () => {
          const remain = Math.round((deadline - Date.now()) / 1000);
          timerEl.textContent = `⏱ ${fmtClock(remain)} left`;
          timerEl.classList.toggle('low', remain <= 300);
          if (remain === 300) toast('5 minutes left in this section.');
          if (remain <= 0) {
            clearInterval(timerInt);
            toast(`Time's up for ${s.name}. Answers saved and locked.`);
            await closeSection(s);
          }
        };
        tick();
        timerInt = setInterval(tick, 1000);
      }).catch((err) => reportError(err, "Couldn't load the timer"));
    }
  }

  async function closeSection(s) {
    try {
      await rpc('finish_section', { p_attempt: attempt.id, p_section: s.id });
      secState[s.id] = { ...(secState[s.id] || {}), finished_at: new Date().toISOString() };
      const next = secs.find((x) => !secState[x.id] || !secState[x.id].finished_at);
      if (next) current = next.id;
      drawTabs(); drawSection();
    } catch (err) { reportError(err, "Couldn't finish the section"); }
  }

  function questionRow(s, lq, locked) {
    const n = lq.question_no;
    const val = (answers[s.id] || {})[n] || '';
    const dot = h('span', { class: 'saved-dot' + (val ? ' saved' : ''), 'aria-hidden': 'true' });
    const fk = `${s.id}:${n}`;
    const flag = h('button', {
      class: 'flag', type: 'button', 'aria-pressed': String(!!flags[fk]), title: 'Mark for review', 'aria-label': `Mark question ${n} for review`,
      onclick: () => { flags[fk] = !flags[fk]; if (!flags[fk]) delete flags[fk]; flag.setAttribute('aria-pressed', String(!!flags[fk])); saveFlags(); },
    }, '⚑');

    let pending = null;
    async function save(v) {
      const prev = (answers[s.id] || {})[n] || '';
      (answers[s.id] ||= {})[n] = v;
      updateProgress();
      dot.className = 'saved-dot saving';
      const mine = pending = Symbol('save');
      try {
        await rpc('save_response', { p_attempt: attempt.id, p_section: s.id, p_question: n, p_answer: v || null });
        if (pending === mine) dot.className = 'saved-dot' + (v ? ' saved' : '');
      } catch (err) {
        answers[s.id][n] = prev;
        updateProgress();
        dot.className = 'saved-dot err';
        reportError(err, `Question ${n} didn't save`);
        if (String(err && err.message).includes('HW:time_up') || String(err && err.message).includes('HW:section_closed')) closeSection(s);
      }
    }

    let control;
    if (lq.qtype === 'grid') {
      const inp = h('input', {
        type: 'text', class: 'grid-in', value: val, maxlength: 12, inputmode: 'decimal', disabled: locked,
        'aria-label': `Answer for question ${n}`, autocomplete: 'off', placeholder: 'e.g. 3/4',
      });
      const commit = () => {
        const v = normAnswer(inp.value);
        if (!isValidAnswer(v)) { toast('Enter a number like 12, -3, .75 or 3/4.', true); return; }
        inp.value = v;
        if (v !== ((answers[s.id] || {})[n] || '')) save(v);
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
      control = inp;
    } else {
      const btns = ['A', 'B', 'C', 'D'].map((L) => h('button', {
        type: 'button', class: 'bubble', 'aria-pressed': String(val === L), disabled: locked, 'aria-label': `Question ${n}, choice ${L}`,
        onclick: () => {
          const cur = (answers[s.id] || {})[n] || '';
          const v = cur === L ? '' : L;
          btns.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === v)));
          save(v);
        },
      }, L));
      control = h('div', { class: 'bubbles', role: 'group', 'aria-label': `Question ${n}` }, btns);
    }
    return h('div', { class: 'qrow' }, h('span', { class: 'qnum' }, `${n}.`), control, dot, flag);
  }

  const tabs = h('div', { class: 'sec-tabs' });
  function drawTabs() {
    if (secs.length < 2) { mount(tabs); return; }
    mount(tabs, secs.map((s) => {
      const st = secState[s.id];
      return h('button', {
        type: 'button', class: 'sec-tab' + (s.id === current ? ' active' : '') + (st && st.finished_at ? ' closed' : ''),
        onclick: () => { current = s.id; drawTabs(); drawSection(); },
      }, s.name, st && st.finished_at ? ' ✓' : '');
    }));
  }

  mount(answerPane,
    h('a', { href: '#/', class: 'small' }, '← My work'),
    h('h2', { style: 'margin:.5rem 0 .2rem' }, a.material.title),
    h('p', { class: 'small muted', style: 'margin:0' }, `Due ${fmtDate(a.due_at)}`),
    progressLine,
    a.note && h('p', { class: 'notice small' }, a.note),
    a.material.description && h('p', { class: 'small' }, a.material.description),
    h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:1rem 0' }),
    tabs, body,
    h('div', { class: 'card', style: 'margin-top:1.25rem' },
      h('h3', {}, 'Show your work (optional)'),
      h('p', { class: 'small muted' }, 'Take photos of your written work and upload them for your tutor.'),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => fileIn.click() }, '📷 Upload photos'),
      fileIn, uploadsBox),
    h('div', { style: 'margin-top:1.25rem' },
      h('button', { class: 'btn gold', type: 'button', style: 'width:100%', onclick: submit }, 'Submit assignment')),
  );
  updateProgress();
  drawTabs();
  drawSection();
}

// ---------------- Results ----------------

async function resultsView(app, assignmentId) {
  const a = await q(sb.from('assignments').select('*, material:materials(*), attempt:attempts(*)').eq('id', assignmentId).single());
  a.material = one(a.material); a.attempt = one(a.attempt);
  const at = a.attempt;
  if (!at || !at.submitted_at) { location.hash = `#/do/${assignmentId}`; return; }
  const [secs, res, times] = await Promise.all([
    q(sb.from('material_sections').select('*').eq('material_id', a.material.id).order('position')),
    rpc('attempt_results', { p_attempt: at.id }),
    q(sb.from('attempt_sections').select('*').eq('attempt_id', at.id)),
  ]);
  const bySec = {};
  res.forEach((r) => { (bySec[r.section_id] ||= []).push(r); });
  const tBy = {};
  times.forEach((t) => { tBy[t.section_id] = t; });
  const showCorrect = res.some((r) => r.correct);

  mount(app,
    h('a', { href: '#/', class: 'small' }, '← My work'),
    h('div', { class: 'page-head', style: 'margin-top:.5rem' }, h('h1', {}, a.material.title), kindPill(a.material.kind)),
    h('div', { class: 'card', style: 'margin-bottom:1rem;text-align:center' },
      at.total ? h('div', { class: 'score-big' }, `${at.score} / ${at.total}`) : h('div', { class: 'score-big' }, 'Submitted'),
      at.total ? h('p', { class: 'muted', style: 'margin:0' }, `${Math.round((100 * at.score) / at.total)}% correct · submitted ${fmtDate(at.submitted_at)}`)
        : h('p', { class: 'muted', style: 'margin:0' }, `Submitted ${fmtDate(at.submitted_at)}. Your tutor will review it.`)),
    at.tutor_feedback && h('div', { style: 'margin-bottom:1rem' }, h('h3', {}, 'Feedback from your tutor'), h('div', { class: 'feedback' }, at.tutor_feedback)),
    secs.map((s) => {
      const rs = bySec[s.id] || [];
      const t = tBy[s.id];
      const right = rs.filter((r) => r.is_correct).length;
      const graded = rs.filter((r) => r.is_correct !== null).length;
      const wrong = rs.filter((r) => r.is_correct === false).map((r) => r.question_no);
      return h('div', { class: 'card', style: 'margin-bottom:1rem' },
        h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, s.name), h('span', { class: 'spacer' }),
          h('span', { class: 'small muted' }, graded ? `${right}/${graded} correct` : '', t && t.finished_at ? ` · ${fmtDuration((new Date(t.finished_at) - new Date(t.started_at)) / 1000)}` : '')),
        wrong.length ? h('p', { class: 'small' }, `To review: question${wrong.length > 1 ? 's' : ''} ${wrong.join(', ')}`) : graded ? h('p', { class: 'small' }, 'All correct!') : '',
        rs.length > 0 && h('details', {}, h('summary', { class: 'small' }, 'See every answer'),
          h('div', { class: 'table-wrap', style: 'margin-top:.5rem' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Your answer'), showCorrect && h('th', {}, 'Correct answer'), h('th', {}, ''))),
            h('tbody', {}, rs.map((r) => h('tr', { class: 'res-row' },
              h('td', {}, String(r.question_no)),
              h('td', {}, r.answer || '—'),
              showCorrect && h('td', {}, (r.correct || []).join(' or ') || '—'),
              h('td', { class: r.is_correct ? 'ok' : r.is_correct === false ? 'bad' : '' }, r.is_correct ? '✓' : r.is_correct === false ? '✗' : ''))))))));
    }),
  );
}
