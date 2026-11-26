import { h, mount, toast, reportError } from './ui.js';
import { sb, q, configured, portalUrl } from './db.js';
import * as tutor from './tutor.js';
import * as student from './student.js';

const app = document.getElementById('app');
const nav = document.getElementById('topnav');

const state = { session: null, role: null, me: null };

function setNav(links) {
  const here = location.hash || '#/';
  mount(nav,
    links.map(([href, text]) => h('a', { href, class: here === href || (href !== '#/' && here.startsWith(href)) ? 'active' : '' }, text)),
    state.session && h('span', { class: 'who' }, state.session.user.email),
    state.session && h('button', { type: 'button', onclick: signOut }, 'Sign out'),
  );
}

async function signOut() {
  await sb.auth.signOut();
  state.session = null; state.role = null; state.me = null;
  location.hash = '#/';
  route();
}

// ---------------- Sign-in ----------------

function signInView() {
  app.classList.remove('wide');
  setNav([]);
  const email = h('input', { type: 'email', id: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const code = h('input', { type: 'text', id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 10, placeholder: '6-digit code' });
  const sendBtn = h('button', { class: 'btn gold', type: 'submit' }, 'Email me a sign-in link');
  const codeBox = h('div', { hidden: true },
    h('p', { class: 'notice small' }, 'Check your email. Click the link in it, or type the code from the email here.'),
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Code from the email'), code),
    h('button', { class: 'btn', type: 'button', onclick: verifyCode }, 'Sign in with code'),
  );

  async function send(e) {
    e.preventDefault();
    const addr = email.value.trim().toLowerCase();
    if (!addr) return;
    sendBtn.disabled = true;
    try {
      const { error } = await sb.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: portalUrl() } });
      if (error) throw error;
      codeBox.hidden = false;
      toast('Sign-in email sent.');
    } catch (err) {
      if (err && err.status === 429) toast('Too many sign-in emails. Wait a minute and try again.', true);
      else reportError(err, "Couldn't send the sign-in email");
    } finally { sendBtn.disabled = false; }
  }

  async function verifyCode() {
    try {
      const { error } = await sb.auth.verifyOtp({ email: email.value.trim().toLowerCase(), token: code.value.trim(), type: 'email' });
      if (error) throw error;
    } catch (err) {
      toast("That code didn't work. Check it, or request a new email.", true);
    }
  }

  mount(app, h('div', { class: 'auth' },
    h('div', { class: 'card' },
      h('h1', {}, 'Sign in'),
      h('p', { class: 'muted' }, 'Enter the email address your tutor has on file. We’ll email you a link to sign in. No password needed.'),
      h('form', { onsubmit: send },
        h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), email),
        sendBtn,
      ),
      h('div', { style: 'margin-top:1rem' }, codeBox),
    ),
  ));
  email.focus();
}

function notConfiguredView() {
  mount(app, h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('h1', {}, 'Almost ready'),
    h('p', {}, 'The Student Portal is not connected to its database yet. Fill in homework/config.js as described in homework/SETUP.md.'),
  )));
}

function notOnRosterView() {
  setNav([]);
  mount(app, h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('h1', {}, 'No assignments found'),
    h('p', {}, `You're signed in as ${state.session.user.email}, but this email isn't on Tutoring Jedi's student list.`),
    h('p', { class: 'muted' }, 'Ask your tutor which email they used for you, then sign out and sign in with that one.'),
    h('button', { class: 'btn', type: 'button', onclick: signOut }, 'Sign out'),
  )));
}

// ---------------- Role ----------------

async function loadRole() {
  const email = state.session.user.email.toLowerCase();
  const tutors = await q(sb.from('tutors').select('email').eq('email', email));
  if (tutors.length) { state.role = 'tutor'; return; }
  const me = await q(sb.from('students').select('id, full_name, email').eq('email', email).maybeSingle());
  if (me) { state.role = 'student'; state.me = me; return; }
  state.role = 'none';
}

// ---------------- Router ----------------

let routing = 0;
async function route() {
  const token = ++routing;
  if (!configured) return notConfiguredView();
  if (!state.session) return signInView();
  try {
    if (!state.role) await loadRole();
  } catch (err) {
    reportError(err, "Couldn't load your account");
    return;
  }
  if (token !== routing) return;
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  app.classList.remove('wide');
  mount(app, h('div', { class: 'loading' }, 'Loading…'));
  try {
    if (state.role === 'tutor') {
      setNav([['#/', 'Progress'], ['#/students', 'Students'], ['#/library', 'Library'], ['#/assign', 'Assign']]);
      await tutor.render(app, parts, state);
    } else if (state.role === 'student') {
      setNav([['#/', 'My work']]);
      await student.render(app, parts, state);
    } else {
      notOnRosterView();
    }
  } catch (err) {
    reportError(err, "Couldn't load this page");
    mount(app, h('div', { class: 'empty' }, "This page couldn't be loaded. ", h('a', { href: '#/' }, 'Go back')));
  }
}

window.addEventListener('hashchange', route);

if (configured) {
  sb.auth.onAuthStateChange((_event, session) => {
    const changed = (session && session.user.id) !== (state.session && state.session.user.id);
    state.session = session;
    if (changed) {
      state.role = null; state.me = null;
      // Clean auth tokens out of the address bar after a magic-link sign-in.
      if (/access_token|error_description/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/');
      setTimeout(route, 0);
    }
  });
  sb.auth.getSession().then(({ data }) => {
    state.session = data.session;
    if (/access_token|error_description/.test(location.hash)) {
      if (!data.session) toast('That sign-in link has expired. Request a new one.', true);
      history.replaceState(null, '', location.pathname + '#/');
    }
    route();
  });
} else {
  route();
}
