import { BROWSER_PASSWORD_MESSAGE_PREFIX } from './browser-credential-types'

// Why: runs in an isolated world (1208) so page scripts can neither read the
// per-tab token nor tamper with detection/fill state. Communication is via
// console.debug — the same guest->host channel the annotation bridge uses.
export function buildBrowserPasswordBridgeScript({
  token,
  enabled
}: {
  token: string
  enabled: boolean
}): string {
  return `(() => {
  'use strict';
  const enabled = ${JSON.stringify(enabled)};
  const token = ${JSON.stringify(token)};
  const prefix = ${JSON.stringify(BROWSER_PASSWORD_MESSAGE_PREFIX)};
  const stateKey = '__orcaPasswordBridgeState';
  const attrUser = 'data-orca-pwid';
  const attrPass = 'data-orca-pwid-pass';

  const teardown = (state) => {
    if (!state) return;
    // Why: cancel in-flight RAF and debounced detect so stale events cannot
    // fire after disable/reinject (fix for pending-work leak on teardown).
    if (state.raf) cancelAnimationFrame(state.raf);
    if (state.debounce) clearTimeout(state.debounce);
    if (state.observer) state.observer.disconnect();
    if (state.onScroll) {
      window.removeEventListener('scroll', state.onScroll, true);
      window.removeEventListener('resize', state.onScroll, true);
    }
    if (state.onSubmit) document.removeEventListener('submit', state.onSubmit, true);
  };

  const prev = globalThis[stateKey];
  if (!enabled) { teardown(prev); delete globalThis[stateKey]; delete globalThis.__orcaPasswordBridge; return true; }
  if (prev) teardown(prev);

  const emit = (payload) => {
    try { console.debug(prefix + token + ':' + JSON.stringify(payload)); } catch (e) {}
  };
  const origin = (() => { try { return location.origin; } catch (e) { return ''; } })();

  const findUsernameFor = (passwordEl) => {
    const form = passwordEl.form;
    const scope = form || document;
    const inputs = Array.prototype.slice.call(scope.querySelectorAll('input'));
    const idx = inputs.indexOf(passwordEl);
    for (let i = idx - 1; i >= 0; i--) {
      const t = (inputs[i].getAttribute('type') || 'text').toLowerCase();
      if (t === 'text' || t === 'email' || t === 'tel' || t === '') return inputs[i];
    }
    return null;
  };

  let counter = 0;
  const pairs = new Map(); // fieldId -> { user, pass }

  const detect = () => {
    pairs.clear();
    // Why: re-detection (MutationObserver / scroll) must not leave orphaned
    // attributes that desync from the pairs map.
    Array.prototype.forEach.call(document.querySelectorAll('[' + attrUser + '],[' + attrPass + ']'), (el) => {
      el.removeAttribute(attrUser); el.removeAttribute(attrPass);
    });
    const fields = [];
    const passwords = Array.prototype.slice.call(document.querySelectorAll('input[type="password"]'));
    passwords.forEach((passwordEl) => {
      const userEl = findUsernameFor(passwordEl);
      const fieldId = 'pf-' + (++counter);
      passwordEl.setAttribute(attrPass, fieldId);
      if (userEl) userEl.setAttribute(attrUser, fieldId);
      pairs.set(fieldId, { user: userEl, pass: passwordEl });
      const anchor = userEl || passwordEl;
      const r = anchor.getBoundingClientRect();
      fields.push({ fieldId, rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
    });
    emit({ type: 'detect', origin, fields });
  };

  const state = { observer: null, onScroll: null, onSubmit: null, raf: 0, debounce: 0 };

  state.onScroll = () => {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => { state.raf = 0; detect(); });
  };
  state.onSubmit = (e) => {
    const form = e.target;
    pairs.forEach(({ user, pass }) => {
      if (!pass || (form && pass.form !== form)) return;
      emit({ type: 'capture', origin, username: user ? user.value : '', password: pass.value });
    });
  };

  state.observer = new MutationObserver(() => {
    clearTimeout(state.debounce);
    state.debounce = setTimeout(detect, 300);
  });

  globalThis.__orcaPasswordBridge = {
    fill: (fieldId, username, password) => {
      // Why: fieldId comes from an external caller; escape it so special CSS
      // characters cannot break the double-quoted attribute selector. The
      // fallback mirrors escapeCssAttrValue in tab-group-panel-split-target.ts.
      const esc = (typeof CSS !== 'undefined' && CSS.escape)
        ? CSS.escape(fieldId)
        : fieldId.split('\\\\').join('\\\\\\\\').split('"').join('\\\\\\"');
      const userEl = document.querySelector('[' + attrUser + '="' + esc + '"]');
      const passEl = document.querySelector('[' + attrPass + '="' + esc + '"]');
      const set = (el, value) => {
        if (!el) return;
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (username) set(userEl, username);
      set(passEl, password);
      return true;
    }
  };

  window.addEventListener('scroll', state.onScroll, true);
  window.addEventListener('resize', state.onScroll, true);
  document.addEventListener('submit', state.onSubmit, true);
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis[stateKey] = state;
  detect();
  return true;
})();`
}

export function buildBrowserPasswordFillCall(
  fieldId: string,
  username: string,
  password: string
): string {
  return `window.__orcaPasswordBridge && window.__orcaPasswordBridge.fill(${JSON.stringify(
    fieldId
  )}, ${JSON.stringify(username)}, ${JSON.stringify(password)});`
}
