import type { BrowserGrabRect } from './browser-grab-types'
import { COMPOSED_TREE_SCRIPT } from './browser-composed-tree-script'
import { isValidBrowserGrabRect } from './browser-annotation-viewport-report'

export type BrowserAnnotationViewportBridgeMarker = {
  id: string
  index: number
  rectPage: BrowserGrabRect
  rectViewport: BrowserGrabRect
  isFixed: boolean
}

export type BrowserSetAnnotationViewportBridgeArgs = {
  browserPageId: string
  enabled: boolean
  emitViewport: boolean
  markers: BrowserAnnotationViewportBridgeMarker[]
  selectionId?: string
  token: string
}

export type BrowserAnnotationViewportBridgeOptions = {
  enabled: boolean
  emitViewport: boolean
  markers: BrowserAnnotationViewportBridgeMarker[]
  selectionId?: string
  token: string
}

export const BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID = 1207
export const BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX = '__orca_annotation_viewport__:'
// Set by the grab overlay on the element it froze on, so the isolated bridge can measure it.
export const BROWSER_GRAB_SELECTED_ATTRIBUTE = 'data-orca-grab-selected'

export function isValidBrowserAnnotationViewportBridgeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value)
}

export function isValidBrowserAnnotationViewportBridgeMarkers(
  value: unknown
): value is BrowserAnnotationViewportBridgeMarker[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((marker) => {
      if (!marker || typeof marker !== 'object') {
        return false
      }
      const candidate = marker as Record<string, unknown>
      return (
        typeof candidate.id === 'string' &&
        candidate.id.length > 0 &&
        candidate.id.length <= 100 &&
        Number.isInteger(candidate.index) &&
        (candidate.index as number) >= 0 &&
        (candidate.index as number) < 100 &&
        typeof candidate.isFixed === 'boolean' &&
        isValidBrowserGrabRect(candidate.rectPage) &&
        isValidBrowserGrabRect(candidate.rectViewport)
      )
    })
  )
}

// Why: persisted badges need to follow guest scroll without a React roundtrip;
// the bridge mirrors only numeric marker geometry into a closed shadow overlay.
export function buildBrowserAnnotationViewportBridgeScript({
  emitViewport,
  enabled,
  markers,
  selectionId,
  token
}: BrowserAnnotationViewportBridgeOptions): string {
  return `(() => {
  'use strict';

  const enabled = ${JSON.stringify(enabled)};
  const emitViewportMessages = ${JSON.stringify(emitViewport)};
  const markers = ${JSON.stringify(markers)};
  const selectionId = ${JSON.stringify(selectionId ?? null)};
  const token = ${JSON.stringify(token)};
  const prefix = ${JSON.stringify(BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX)};
  const stateKey = '__orcaBrowserAnnotationViewportBridge';
  const hostAttribute = 'data-orca-browser-annotation-overlay';
  const selectedAttribute = ${JSON.stringify(BROWSER_GRAB_SELECTED_ATTRIBUTE)};
  const markerSize = 24;
${COMPOSED_TREE_SCRIPT}

  const removeOverlay = (state) => {
    if (state && state.host && state.host.parentNode) {
      state.host.parentNode.removeChild(state.host);
    }
  };

  const cleanup = (state) => {
    if (!state) return;
    if (state.raf) {
      cancelAnimationFrame(state.raf);
    }
    if (state.requestUpdate) {
      window.removeEventListener('scroll', state.requestUpdate, true);
      document.removeEventListener('scroll', state.requestUpdate, true);
      window.removeEventListener('resize', state.requestUpdate, true);
    }
    if (state.onBeforeUnload) {
      window.removeEventListener('beforeunload', state.onBeforeUnload);
    }
    if (state.targetObserver) {
      state.targetObserver.disconnect();
    }
    state.targetShadowRoots.forEach((root) => root.removeEventListener('scroll', state.requestUpdate, true));
    removeOverlay(state);
  };

  const existing = globalThis[stateKey];
  if (!enabled) {
    cleanup(existing);
    delete globalThis[stateKey];
    return true;
  }

  const toNumber = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  const readViewport = () => ({
    scrollX: toNumber(window.scrollX, toNumber(window.pageXOffset, 0)),
    scrollY: toNumber(window.scrollY, toNumber(window.pageYOffset, 0))
  });

  const findMarked = (root) =>
    Array.from(root.querySelectorAll('[' + selectedAttribute + ']')).filter(
      (candidate) => candidate.getAttribute(selectedAttribute) === selectionId
    );

  // Document queries stop at shadow roots, so open ones are walked when the light DOM has no match.
  const findMarkedInShadowRoots = (root) =>
    Array.from(root.querySelectorAll('*')).flatMap((element) =>
      element.shadowRoot ? findMarked(element.shadowRoot).concat(findMarkedInShadowRoots(element.shadowRoot)) : []
    );

  // Why: the card must follow the element itself, not a click-time copy; the grab overlay
  // marks it in the shared DOM because this world cannot see the page's objects.
  const trackTarget = (state) => {
    const current = state.target;
    let next = null;
    if (emitViewportMessages && selectionId) {
      let found = findMarked(document);
      if (found.length === 0) {
        // The marker is set before the selection reaches this bridge, so one shadow walk per selection suffices.
        const keep = current && current.isConnected && current.getAttribute(selectedAttribute) === selectionId;
        if (keep) found = [current];
        else if (state.searchedSelectionId !== selectionId) {
          state.searchedSelectionId = selectionId;
          found = findMarkedInShadowRoots(document);
        }
      }
      next = found.length === 1 ? found[0] : null;
    }
    if (next !== current) {
      state.target = next;
      state.targetShadowRoots.forEach((root) => root.removeEventListener('scroll', state.requestUpdate, true));
      state.targetShadowRoots = next ? shadowRootsAbove(next) : [];
      state.targetShadowRoots.forEach((root) => root.addEventListener('scroll', state.requestUpdate, true));
      if (state.targetObserver) {
        state.targetObserver.disconnect();
        if (next) {
          state.targetObserver.observe(next, { box: 'border-box' });
          if (next !== document.documentElement) {
            state.targetObserver.observe(document.documentElement);
          }
        }
      }
    }
    return next;
  };

  const readTarget = (target) => {
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };

  const emitViewport = (state) => {
    const target = trackTarget(state);
    if (!emitViewportMessages) return;
    try {
      const report = readViewport();
      report.viewportWidth = toNumber(window.innerWidth, 0);
      report.target = readTarget(target);
      console.debug(prefix + token + ':' + JSON.stringify(report));
    } catch (e) {}
  };

  const getRoot = () => document.body || document.documentElement;

  const ensureOverlay = (state) => {
    if (state.host && state.shadowRoot) {
      return state.shadowRoot;
    }
    const root = getRoot();
    if (!root) return null;
    const host = document.createElement('div');
    host.setAttribute(hostAttribute, '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style paint;overflow:hidden;';
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = '.marker{box-sizing:border-box;position:absolute;left:0;top:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:9999px;border:1px solid rgba(255,255,255,0.95);background:#2563eb;color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 24px rgba(0,0,0,.18);will-change:transform;pointer-events:none;user-select:none;}';
    shadowRoot.appendChild(style);
    root.appendChild(host);
    state.host = host;
    state.shadowRoot = shadowRoot;
    return shadowRoot;
  };

  const updateMarkers = (state, nextMarkers) => {
    state.markers = Array.isArray(nextMarkers) ? nextMarkers : [];
    if (state.markers.length === 0) {
      removeOverlay(state);
      state.host = null;
      state.shadowRoot = null;
      state.markerElements = new Map();
      return;
    }
    const shadowRoot = ensureOverlay(state);
    if (!shadowRoot) return;
    const liveIds = new Set();
    state.markers.forEach((marker) => {
      liveIds.add(marker.id);
      let element = state.markerElements.get(marker.id);
      if (!element) {
        element = document.createElement('span');
        element.className = 'marker';
        shadowRoot.appendChild(element);
        state.markerElements.set(marker.id, element);
      }
      element.textContent = String(marker.index + 1);
    });
    state.markerElements.forEach((element, id) => {
      if (!liveIds.has(id)) {
        element.remove();
        state.markerElements.delete(id);
      }
    });
  };

  const positionMarkers = (state) => {
    if (!state.markers || state.markers.length === 0) return;
    const viewport = readViewport();
    const viewportWidth = toNumber(window.innerWidth, 0);
    const viewportHeight = toNumber(window.innerHeight, 0);
    state.markers.forEach((marker) => {
      const element = state.markerElements.get(marker.id);
      if (!element) return;
      const sourceRect = marker.isFixed ? marker.rectViewport : marker.rectPage;
      const x = marker.isFixed ? sourceRect.x : sourceRect.x - viewport.scrollX;
      const y = marker.isFixed ? sourceRect.y : sourceRect.y - viewport.scrollY;
      const width = toNumber(sourceRect.width, 0);
      const height = toNumber(sourceRect.height, 0);
      const visible =
        x + width >= 0 &&
        y + height >= 0 &&
        x <= viewportWidth &&
        y <= viewportHeight;
      if (!visible) {
        element.style.display = 'none';
        return;
      }
      element.style.display = 'flex';
      element.style.transform =
        'translate3d(' +
        (x + width / 2 - markerSize / 2) +
        'px,' +
        (y + height - markerSize / 2) +
        'px,0)';
    });
  };

  if (existing && existing.requestUpdate) {
    existing.emitViewport = emitViewport;
    updateMarkers(existing, markers);
    existing.requestUpdate();
    return true;
  }

  const state = {
    raf: 0,
    emitViewport,
    host: null,
    markerElements: new Map(),
    markers: [],
    shadowRoot: null,
    requestUpdate: null,
    onBeforeUnload: null,
    target: null,
    targetObserver: null,
    targetShadowRoots: [],
    searchedSelectionId: null
  };

  state.requestUpdate = () => {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      positionMarkers(state);
      state.emitViewport(state);
    });
  };
  if (typeof ResizeObserver === 'function') {
    state.targetObserver = new ResizeObserver(state.requestUpdate);
  }

  // Navigation can hold IPC cleanup until the next document finishes loading.
  state.onBeforeUnload = () => {
    cleanup(state);
    delete globalThis[stateKey];
  };

  updateMarkers(state, markers);
  window.addEventListener('scroll', state.requestUpdate, true);
  document.addEventListener('scroll', state.requestUpdate, true);
  window.addEventListener('resize', state.requestUpdate, true);
  window.addEventListener('beforeunload', state.onBeforeUnload);
  globalThis[stateKey] = state;
  state.requestUpdate();
  return true;
})();`
}
