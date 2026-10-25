// Slide viewer: scale the 1920x1080 canvas to fit, show one slide at a time,
// page with keys, clicks, swipes or the buttons. The slide number lives in the
// URL hash (#3) so a link can open a specific slide.
(() => {
  const CANVAS = { w: 1920, h: 1080 };
  const SWIPE_PX = 40;

  const viewport = document.querySelector('.viewport');
  const stage = document.querySelector('.stage');
  const slides = [...stage.querySelectorAll(':scope > section')];
  const prev = document.querySelector('.prev');
  const next = document.querySelector('.next');
  const count = document.querySelector('.count');
  const langSwitch = document.querySelector('.lang-switch');
  const langBase = langSwitch?.getAttribute('href');

  let current = -1;

  const fromHash = () => {
    const n = Number.parseInt(location.hash.slice(1), 10);
    return Number.isInteger(n) ? Math.min(Math.max(n, 1), slides.length) - 1 : 0;
  };

  const show = (index) => {
    const target = Math.min(Math.max(index, 0), slides.length - 1);
    if (target === current) return;
    slides[current]?.classList.remove('on');
    slides[current]?.setAttribute('aria-hidden', 'true');
    slides[target].classList.add('on');
    slides[target].removeAttribute('aria-hidden');
    current = target;
    count.textContent = `${current + 1} / ${slides.length}`;
    prev.disabled = current === 0;
    next.disabled = current === slides.length - 1;
    history.replaceState(null, '', `#${current + 1}`);
    if (langSwitch) langSwitch.href = `${langBase}#${current + 1}`;
  };

  const fit = () => {
    const { clientWidth: w, clientHeight: h } = viewport;
    stage.style.setProperty('--scale', Math.min(w / CANVAS.w, h / CANVAS.h));
  };

  slides.forEach((s) => s.setAttribute('aria-hidden', 'true'));
  prev.addEventListener('click', () => show(current - 1));
  next.addEventListener('click', () => show(current + 1));

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const steps = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 };
    if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(slides.length - 1);
    else if (steps[e.key] && !(e.key === ' ' && e.target.closest('button, a'))) show(current + steps[e.key]);
    else return;
    e.preventDefault();
  });

  // Click the left third to go back, anywhere else to go forward.
  let swiped = false;
  viewport.addEventListener('click', (e) => {
    // A swipe already paged, so ignore the click the browser sends after it.
    if (swiped) { swiped = false; return; }
    if (e.target.closest('a')) return;
    const { left, width } = viewport.getBoundingClientRect();
    show(current + (e.clientX - left < width / 3 ? -1 : 1));
  });

  let touchX = null;
  viewport.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  viewport.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    swiped = Math.abs(dx) >= SWIPE_PX;
    if (swiped) show(current + (dx < 0 ? 1 : -1));
  });

  window.addEventListener('hashchange', () => show(fromHash()));
  new ResizeObserver(fit).observe(viewport);
  fit();
  show(fromHash());
})();
