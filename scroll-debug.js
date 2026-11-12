// scroll-debug.js — loaded only with ?debug=scroll. A small panel showing the scroll position and a
// log of every scroll change that happens with no finger on the screen, plus what happened just
// before it (viewport resizes, the content area being replaced, class changes). For finding what
// moves the page on a phone; never loaded for normal visitors.
(function () {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;max-width:min(96vw,520px);background:rgba(0,0,0,.88);color:#7fffd4;font:11px/1.35 ui-monospace,Menlo,monospace;padding:6px 8px;border:1px solid #2dd4bf;border-radius:6px;white-space:pre-wrap;pointer-events:none';
  document.body.appendChild(panel);

  const log = [];
  const recent = []; // events in the last second, attached to the next unexplained jump
  const now = () => Math.round(performance.now());
  const note = msg => { recent.push([now(), msg]); while (recent.length && now() - recent[0][0] > 1000) recent.shift(); };
  const vv = window.visualViewport;
  let touching = false, lastTouchEnd = 0, lastY = window.scrollY, lastH = window.innerHeight;

  addEventListener('touchstart', () => { touching = true; }, { passive: true, capture: true });
  addEventListener('touchend', () => { touching = false; lastTouchEnd = now(); note('finger up'); }, { passive: true, capture: true });
  addEventListener('touchcancel', () => { touching = false; lastTouchEnd = now(); note('touch cancelled'); }, { passive: true, capture: true });
  addEventListener('resize', () => { note(`resize h ${lastH}→${innerHeight} w ${innerWidth}`); lastH = innerHeight; });
  if (vv) {
    vv.addEventListener('resize', () => note(`visualViewport h ${Math.round(vv.height)} top ${Math.round(vv.offsetTop)}`));
    vv.addEventListener('scroll', () => note(`visualViewport scroll top ${Math.round(vv.offsetTop)}`));
  }
  addEventListener('orientationchange', () => note('orientationchange'));
  const content = document.getElementById('content');
  if (content) new MutationObserver(() => note(`content replaced, page h ${document.documentElement.scrollHeight}`)).observe(content, { childList: true });
  new MutationObserver(() => note(`html class "${document.documentElement.className}"`)).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  addEventListener('focusin', e => note(`focus ${e.target.tagName}.${e.target.className || ''}`));
  document.addEventListener('click', e => note(`tap ${(e.target.closest('[data-tab]')?.dataset.tab) || e.target.tagName}`), true);

  addEventListener('scroll', () => {
    const y = Math.round(window.scrollY), d = y - lastY;
    // A change with no finger down, after any momentum would have settled (400ms), is unexplained.
    if (!touching && now() - lastTouchEnd > 400 && Math.abs(d) >= 8) {
      const why = recent.filter(([t]) => now() - t <= 1000).map(([t, m]) => `${now() - t}ms ago: ${m}`).slice(-4);
      log.push(`${lastY}→${y} (${d > 0 ? '+' : ''}${d}) no finger${why.length ? '\n   ' + why.join('\n   ') : ' · nothing before it'}`);
      while (log.length > 6) log.shift();
    }
    lastY = y;
  }, { passive: true });

  const render = () => {
    const top = Math.round(document.getElementById('content')?.getBoundingClientRect().top ?? NaN);
    panel.textContent = `scrollY ${Math.round(scrollY)} · content top on screen ${top} · window h ${innerHeight}` +
      (vv ? ` · visible h ${Math.round(vv.height)} offset ${Math.round(vv.offsetTop)}` : '') +
      ` · page h ${document.documentElement.scrollHeight}\n` +
      (log.length ? 'Jumps with no finger down:\n' + log.join('\n') : 'No jumps with no finger down yet.');
    requestAnimationFrame(render);
  };
  render();
})();
