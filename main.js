/*
 * main.js — page behaviour for the portfolio (no framework, no build step).
 * The fluid background lives in fluid.js.
 */
(function () {
  'use strict';

  /* -------- settings you may want to change -------- */
  // Contact-form messages are emailed straight to this address by FormSubmit.co
  // (free, no account). The very first submission triggers a one-time confirmation
  // email — see README.md. After confirming, you can swap CONTACT_EMAIL in the
  // endpoint for the random string FormSubmit sends you, to keep your address
  // out of the page source.
  var CONTACT_EMAIL = 'thakur.07anurag@gmail.com';
  var FORM_ENDPOINT = 'https://formsubmit.co/ajax/' + CONTACT_EMAIL;
  var ROLES = ['Visual Designer', 'Web Developer', 'Presentation Designer', 'Graphic Designer'];
  var THEME_KEY = 'portfolio-theme';

  /* -------- tiny helpers -------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function toggle(el, classes, on) {
    classes.split(' ').forEach(function (c) { el.classList.toggle(c, on); });
  }
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;

  /* ======================================================================
   * Theme (light / dark)
   * ==================================================================== */
  function currentTheme() { return root.classList.contains('dark') ? 'dark' : 'light'; }

  function paintToggleIcon(icon, visible, hiddenRotation) {
    if (!icon) return;
    toggle(icon, 'opacity-100 rotate-0 scale-100', visible);
    toggle(icon, 'opacity-0 scale-50 ' + hiddenRotation, !visible);
  }

  function syncThemeButtons() {
    var dark = currentTheme() === 'dark';
    var label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    $$('.theme-toggle').forEach(function (btn) {
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', String(dark));
      btn.title = label;
      paintToggleIcon($('.ri-sun-line', btn), !dark, '-rotate-90');
      paintToggleIcon($('.ri-moon-line', btn), dark, 'rotate-90');
    });
  }

  function setTheme(theme) {
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
    // brief class that lets every colour cross-fade
    root.classList.add('theme-transition');
    setTimeout(function () { root.classList.remove('theme-transition'); }, 460);
    syncThemeButtons();
  }

  $$('.theme-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
  });
  syncThemeButtons();

  /* ======================================================================
   * Scroll: progress bar, sticky header, back-to-top
   * ==================================================================== */
  var progress = $('#scroll-progress');
  var header = $('#site-header');
  var toTop = $('#back-to-top');
  var ticking = false;

  function onScroll() {
    ticking = false;
    var y = window.scrollY;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (progress) progress.style.width = (max > 0 ? (y / max) * 100 : 0) + '%';

    if (header) {
      var scrolled = y > 40;
      toggle(header, 'bg-background-50/90 backdrop-blur-md border-background-200', scrolled);
      toggle(header, 'bg-transparent border-transparent', !scrolled);
    }

    if (toTop) {
      var show = y > 500;
      toggle(toTop, 'opacity-100 translate-y-0', show);
      toggle(toTop, 'opacity-0 translate-y-4 pointer-events-none', !show);
      toTop.tabIndex = show ? 0 : -1;
    }
  }

  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll();

  if (toTop) {
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }

  /* ======================================================================
   * Mobile menu
   * ==================================================================== */
  var menu = $('#mobile-menu');
  var drawer = $('#mobile-drawer');
  var menuOpenBtn = $('#menu-open');
  var menuCloseBtn = $('#menu-close');

  function setMenu(open, restoreFocus) {
    if (!menu || !drawer) return;
    toggle(menu, 'opacity-100 pointer-events-auto', open);
    toggle(menu, 'opacity-0 pointer-events-none', !open);
    toggle(drawer, 'translate-x-0', open);
    toggle(drawer, 'translate-x-full', !open);
    menu.inert = !open;
    document.body.style.overflow = open ? 'hidden' : '';
    if (menuOpenBtn) menuOpenBtn.setAttribute('aria-expanded', String(open));
    if (open && menuCloseBtn) menuCloseBtn.focus();
    if (!open && restoreFocus && menuOpenBtn) menuOpenBtn.focus();
  }

  if (menuOpenBtn) menuOpenBtn.addEventListener('click', function () { setMenu(true); });
  if (menuCloseBtn) menuCloseBtn.addEventListener('click', function () { setMenu(false, true); });
  var backdrop = $('#menu-backdrop');
  if (backdrop) backdrop.addEventListener('click', function () { setMenu(false, true); });
  $$('.menu-link').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menu && !menu.inert) setMenu(false, true);
  });
  // if the window grows past the mobile breakpoint, make sure the page can scroll again
  if (window.matchMedia) {
    var desktop = window.matchMedia('(min-width: 768px)');
    var onBreakpoint = function (e) { if (e.matches) setMenu(false); };
    if (desktop.addEventListener) desktop.addEventListener('change', onBreakpoint);
    else if (desktop.addListener) desktop.addListener(onBreakpoint);
  }

  /* ======================================================================
   * Hero: typewriter + hover on the name (which also stirs the fluid)
   * ==================================================================== */
  var typed = $('#typed');
  if (typed) {
    var idx = 0;
    var text = '';
    var deleting = false;
    typed.textContent = '';

    var typeStep = function () {
      var word = ROLES[idx % ROLES.length];
      var delay = deleting ? 45 : 90;
      if (!deleting && text === word) delay = 1500;      // hold the finished word
      else if (deleting && text === '') delay = 320;     // short beat before the next one

      setTimeout(function () {
        if (!deleting && text === word) {
          deleting = true;
        } else if (deleting && text === '') {
          deleting = false;
          idx = (idx + 1) % ROLES.length;
        } else {
          text = deleting ? word.slice(0, text.length - 1) : word.slice(0, text.length + 1);
        }
        typed.textContent = text;
        typeStep();
      }, delay);
    };
    typeStep();
  }

  var nameWords = $$('.name-word');
  var wordBase = 'name-word inline-block transition-all duration-300 ease-out cursor-default';
  function paintNameWords(active) {
    nameWords.forEach(function (el, i) {
      var isLast = i === nameWords.length - 1;
      var color;
      if (active === null) color = isLast ? 'text-primary-600' : 'text-foreground-950';
      else if (active === i) color = 'text-accent-500 -translate-y-2 scale-[1.04]';
      else color = 'text-foreground-400';
      el.className = wordBase + ' ' + color;
    });
  }
  nameWords.forEach(function (el, i) {
    el.addEventListener('mouseenter', function () {
      paintNameWords(i);
      if (window.Fluid) window.Fluid.burst(el.getBoundingClientRect());
    });
    el.addEventListener('mouseleave', function () { paintNameWords(null); });
  });

  /* ======================================================================
   * About: tabs
   * ==================================================================== */
  var tabs = $$('#about-tabs [role="tab"]');
  var panels = $$('[role="tabpanel"][data-panel]');

  function selectTab(id, focus) {
    tabs.forEach(function (tab) {
      var active = tab.getAttribute('data-tab') === id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      toggle(tab, 'bg-primary-500 text-background-50', active);
      toggle(tab, 'text-foreground-600 hover:text-primary-600', !active);
      if (active && focus) tab.focus();
    });
    panels.forEach(function (panel) {
      var show = panel.getAttribute('data-panel') === id;
      panel.hidden = !show;
      panel.classList.remove('panel-fade');
      if (show) {
        void panel.offsetWidth; // restart the fade-in animation
        panel.classList.add('panel-fade');
      }
    });
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { selectTab(tab.getAttribute('data-tab')); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next !== null) { e.preventDefault(); selectTab(tabs[next].getAttribute('data-tab'), true); }
    });
  });

  /* ======================================================================
   * Scroll-triggered effects: reveal, count-up, skill bars
   * ==================================================================== */
  var hasIO = 'IntersectionObserver' in window;
  var VIEW = { threshold: 0.15, rootMargin: '0px 0px -60px 0px' };

  function observeOnce(elements, onEnter) {
    if (!hasIO) { elements.forEach(onEnter); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { onEnter(entry.target); io.unobserve(entry.target); }
      });
    }, VIEW);
    elements.forEach(function (el) { io.observe(el); });
  }

  // fade / slide-in
  observeOnce($$('.reveal, .reveal-left, .reveal-right'), function (el) { el.classList.add('in-view'); });

  // skill bars fill when their card scrolls into view
  observeOnce($$('.skill-card'), function (card) {
    $$('.bar-fill', card).forEach(function (bar) { bar.classList.add('is-on'); });
  });

  // numbers count up when the stats row scrolls into view
  var counters = $$('[data-count]');
  counters.forEach(function (el) { if (!reduceMotion && hasIO) el.textContent = '0'; });

  function countUp(el) {
    var target = parseInt(el.getAttribute('data-count'), 10) || 0;
    if (reduceMotion) { el.textContent = target; return; }
    var duration = 1400;
    var start = performance.now();
    (function tick(now) {
      var p = Math.min((now - start) / duration, 1);
      el.textContent = Math.round((1 - Math.pow(1 - p, 3)) * target); // ease-out cubic
      if (p < 1) requestAnimationFrame(tick);
    })(start);
  }
  var stats = $('#stats');
  if (stats) observeOnce([stats], function () { counters.forEach(countUp); });

  /* ======================================================================
   * Contact form
   * ==================================================================== */
  var form = $('#contact-form');
  if (form) {
    var status = $('#form-status');
    var submitBtn = $('#form-submit');
    var counter = $('#msg-count');
    var message = $('#message');
    var submitHTML = submitBtn.innerHTML;

    var showStatus = function (type, text) {
      var icon = type === 'success' ? 'ri-checkbox-circle-line' : 'ri-error-warning-line';
      var color = type === 'success' ? 'text-primary-700' : 'text-accent-700';
      status.className = 'mt-4 text-[14px] flex items-center gap-2 ' + color;
      status.innerHTML = '<i class="' + icon + '" aria-hidden="true"></i> ';
      status.appendChild(document.createTextNode(text)); // text node: never interpret server text as HTML
    };
    var hideStatus = function () { status.className = 'hidden'; status.textContent = ''; };
    var setLoading = function (loading) {
      submitBtn.disabled = loading;
      submitBtn.innerHTML = loading
        ? '<i class="ri-loader-4-line animate-spin" aria-hidden="true"></i> Sending…'
        : submitHTML;
    };
    var updateCount = function () { counter.textContent = message.value.length; };

    message.addEventListener('input', updateCount);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);

      // Honeypot filled in => a bot. Pretend it worked, send nothing.
      if (String(data.get('website_alt') || '').trim()) {
        showStatus('success', "Thanks! Your message has been sent — I'll be in touch soon.");
        form.reset(); updateCount();
        return;
      }

      function field(name) { return String(data.get(name) || '').trim(); }
      var subject = field('subject');
      var payload = {
        name: (field('firstName') + ' ' + field('lastName')).trim(),
        email: field('email'),          // FormSubmit uses this as the Reply-To
        subject: subject,
        message: field('message'),
        _subject: 'Portfolio message: ' + subject,  // subject line of the email you receive
        _template: 'table',
        _captcha: 'false'
      };

      setLoading(true);
      hideStatus();

      var SUCCESS = "Thanks! Your message has been sent — I'll be in touch soon.";
      var FALLBACK = ' You can also email me directly at ' + CONTACT_EMAIL + '.';

      fetch(FORM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.text().then(function (raw) {
            var json = null;
            try { json = JSON.parse(raw); } catch (err) { json = null; } // e.g. an HTML error page
            var ok = json && (json.success === true || json.success === 'true');
            if (ok) {
              showStatus('success', SUCCESS);
              form.reset(); updateCount();
            } else {
              var why = json && typeof json.message === 'string' && json.message ? json.message : 'Something went wrong.';
              showStatus('error', why + FALLBACK);
            }
          });
        })
        .catch(function () {
          showStatus('error', 'Could not send right now. Please check your connection.' + FALLBACK);
        })
        .then(function () { setLoading(false); });
    });
  }
})();
