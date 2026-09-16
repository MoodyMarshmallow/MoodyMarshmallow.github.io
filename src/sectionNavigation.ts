/** Smooth section and back-to-top links; ordinary page scrolling stays native. */
export function initSectionNavigation(): void {
  const content = document.querySelector<HTMLElement>('.homepage-content');
  if (!content) return;

  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let cancelScroll: (() => void) | undefined;

  content.addEventListener('click', (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
      || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('.homepage-nav a[href^="#"], .back-to-top[href^="#"]') : null;
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const target = document.getElementById(link.hash.slice(1));
    if (!target) return;

    event.preventDefault();
    cancelScroll?.();

    // pushState changes the URL without the browser's immediate anchor jump.
    // Leave scrollRestoration native so Back/Forward restores prior positions.
    if (window.location.hash !== link.hash) history.pushState(null, '', link.hash);

    const previousSnap = root.style.getPropertyValue('scroll-snap-type');
    const previousPriority = root.style.getPropertyPriority('scroll-snap-type');
    root.style.setProperty('scroll-snap-type', 'none', 'important');
    const startY = window.scrollY;
    const destination = () => Math.max(0, Math.min(
      target.getBoundingClientRect().top + window.scrollY,
      root.scrollHeight - window.innerHeight,
    ));
    const endY = destination();
    const duration = Math.min(1200, 900 + Math.abs(endY - startY) * 0.04);
    const startedAt = performance.now();
    const listeners = new AbortController();
    let frame = 0;

    const cleanup = () => {
      cancelAnimationFrame(frame);
      listeners.abort();
      if (previousSnap) root.style.setProperty('scroll-snap-type', previousSnap, previousPriority);
      else root.style.removeProperty('scroll-snap-type');
      cancelScroll = undefined;
    };
    cancelScroll = cleanup;

    const finish = () => {
      // Re-evaluate for font/layout changes and clamp Writing to the page bottom.
      const finalY = destination();
      window.scrollTo({ top: finalY, behavior: 'instant' });
      const previousTabindex = target.getAttribute('tabindex');
      if (previousTabindex === null) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      if (previousTabindex === null) {
        target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
      }
      cleanup();
    };

    const options = { passive: true, signal: listeners.signal };
    window.addEventListener('wheel', cleanup, options);
    window.addEventListener('touchstart', cleanup, options);
    window.addEventListener('pointerdown', cleanup, options);
    window.addEventListener('popstate', cleanup, options);
    window.addEventListener('hashchange', cleanup, options);
    window.addEventListener('keydown', (keyEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Escape', 'Tab'].includes(keyEvent.key)) {
        cleanup();
      }
    }, { signal: listeners.signal });
    reducedMotion.addEventListener('change', finish, { signal: listeners.signal });

    if (reducedMotion.matches || Math.abs(endY - startY) < 1) {
      finish();
      return;
    }

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = progress < 0.5
        ? 4 * progress ** 3
        : 1 - (-2 * progress + 2) ** 3 / 2;
      window.scrollTo({ top: startY + (endY - startY) * eased, behavior: 'instant' });
      if (progress < 1) frame = requestAnimationFrame(step);
      else finish();
    };
    frame = requestAnimationFrame(step);
  });
}
