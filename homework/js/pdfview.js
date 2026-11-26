// PDF viewer built on PDF.js: renders pages to canvas, lazily, with zoom.
import { h } from './ui.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.min.mjs';
const WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.worker.min.mjs';

let libPromise;
function lib() {
  if (!libPromise) {
    libPromise = import(PDFJS).then((m) => {
      m.GlobalWorkerOptions.workerSrc = WORKER;
      return m;
    });
  }
  return libPromise;
}

// Returns an element containing a toolbar and the rendered pages.
export function pdfViewer(url) {
  const pages = h('div', { class: 'pdf-pages' }, h('div', { class: 'pdf-msg' }, 'Loading PDF…'));
  const label = h('span', {}, '');
  let scale = window.innerWidth < 600 ? 1.0 : 1.35;
  let doc = null;
  let observer = null;

  const zoom = (f) => { scale = Math.min(3, Math.max(0.6, scale * f)); render(); };
  const toolbar = h('div', { class: 'pdf-toolbar' },
    h('button', { type: 'button', onclick: () => zoom(1 / 1.2), 'aria-label': 'Zoom out' }, '−'),
    h('button', { type: 'button', onclick: () => zoom(1.2), 'aria-label': 'Zoom in' }, '+'),
    label,
  );
  const root = h('div', { class: 'pdf-root' }, toolbar, pages);

  async function renderPage(n, canvas) {
    const page = await doc.getPage(n);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: scale * ratio });
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.width = `${vp.width / ratio}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
    canvas.dataset.rendered = String(scale);
  }

  async function render() {
    if (!doc) return;
    observer && observer.disconnect();
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale });
    const canvases = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const c = h('canvas', { 'aria-label': `Page ${n}`, dataset: { page: String(n) } });
      c.style.width = `${vp.width}px`;
      c.style.aspectRatio = `${vp.width} / ${vp.height}`;
      canvases.push(c);
    }
    pages.replaceChildren(...canvases);
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const c = e.target;
        if (e.isIntersecting && c.dataset.rendered !== String(scale)) {
          renderPage(Number(c.dataset.page), c).catch((err) => console.error(err));
        }
      }
    }, { root: root.parentElement, rootMargin: '600px 0px' });
    canvases.forEach((c) => observer.observe(c));
    updateLabel();
  }

  // Page number = the page crossing the upper third of the visible area.
  function updateLabel() {
    if (!doc) return;
    const pane = root.parentElement;
    const top = (pane ? pane.getBoundingClientRect().top : 0) + (pane ? pane.clientHeight : window.innerHeight) / 3;
    let n = 1;
    for (const c of pages.children) {
      if (c.getBoundingClientRect().top <= top) n = Number(c.dataset.page) || n;
    }
    label.textContent = `Page ${n} of ${doc.numPages}`;
  }
  let raf = 0;
  const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updateLabel); };
  queueMicrotask(() => {
    (root.parentElement || window).addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
  });

  (async () => {
    try {
      const pdfjs = await lib();
      doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
      label.textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
      await render();
    } catch (err) {
      console.error(err);
      pages.replaceChildren(h('div', { class: 'pdf-msg' }, "The PDF couldn't be shown here. ",
        h('a', { href: url, target: '_blank', rel: 'noopener', style: 'color:#fcd34d' }, 'Open it in a new tab')));
    }
  })();

  return root;
}
