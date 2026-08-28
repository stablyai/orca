import type { ManagedPaneInternal } from './pane-manager-types'
import { captureScrollState, safeFit } from './pane-tree-ops'
import {
  attachPaneFitResizeObserver,
  detachPaneFitResizeObserver
} from './pane-fit-resize-observer'
import { clearPendingSplitScrollRestore } from './pane-split-scroll'
import { cancelDeferredScrollRestore } from './pane-scroll'
import { activateOrcaTerminalUnicodeProvider } from '../../../../shared/terminal-unicode-provider'
import { attachTerminalMouseWheelMultiplier } from './pane-terminal-mouse-wheel'
import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'
import {
  installTerminalLinkifierHoverResetOnMouseLeave,
  installTerminalLinkifierHoverResetOnWindowBlur
} from './terminal-linkifier-hover-reset-on-mouseleave'
import { installTerminalLinkifierHoverResetOnWrite } from './terminal-linkifier-hover-reset-on-write'
import { attachDomRendererFocusClassSync } from './pane-dom-focus-class-sync'
import { attachWebgl, cancelPendingWebglRefresh, disposeWebgl } from './pane-webgl-renderer'
import { rebuildAttachedWebgl } from './pane-webgl-reattach'
import { configureLazyArabicShapingJoiner } from './terminal-arabic-shaping-joiner'
import { TerminalLigaturesAddon } from './terminal-ligatures-addon'
import { installTerminalImeCandidateAnchor } from './terminal-ime-candidate-anchor'

// ---------------------------------------------------------------------------
// Pane creation, terminal open/close, addon management
// ---------------------------------------------------------------------------

export { createPaneDOM } from './pane-dom-creation'

/** Open terminal into its container and load addons. Must be called after the container is in the DOM. */
export function openTerminal(pane: ManagedPaneInternal): void {
  const {
    terminal,
    container,
    xtermContainer,
    linkTooltip,
    terminalTuiScrollSensitivity,
    fitAddon,
    searchAddon,
    serializeAddon,
    unicode11Addon,
    webLinksAddon
  } = pane

  // Open terminal into DOM
  terminal.open(xtermContainer)
  // Why: terminal.element sits under the padded xterm container. Pane-level
  // placement keeps the hover URL on the true bottom-left window corner.
  container.appendChild(linkTooltip)

  // Load addons (order matters: WebGL must be after open())
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  terminal.loadAddon(serializeAddon)
  terminal.loadAddon(unicode11Addon)
  terminal.loadAddon(webLinksAddon)
  attachTerminalMouseWheelMultiplier(terminal, {
    getTuiMouseWheelMultiplier: terminalTuiScrollSensitivity
  })
  pane.terminalScrollIntentDisposable = attachTerminalScrollIntentTracking(
    terminal,
    xtermContainer,
    pane.leafId
  )
  // Why: a link streamed into a visible pane under a stationary pointer would
  // otherwise stay un-underlined/un-clickable until the mouse crosses to a new
  // line; invalidate the linkifier hover cache when output lands so the next
  // pointer move re-linkifies it.
  pane.linkifierHoverResetDisposable = installTerminalLinkifierHoverResetOnWrite(terminal)
  pane.linkifierMouseLeaveResetDisposable = installTerminalLinkifierHoverResetOnMouseLeave(
    terminal,
    linkTooltip
  )
  pane.linkifierWindowBlurResetDisposable = installTerminalLinkifierHoverResetOnWindowBlur(
    terminal,
    linkTooltip
  )

  // Activate Orca's Unicode 11 width shim *before* any caller-driven write. CJK / emoji /
  // ZWJ codepoints get baked into the buffer at the active unicode version on
  // write — if a restore (snapshot, scrollback, cold-restore) writes bytes
  // through xterm while the default v6 width tables are still active, wide
  // chars lay out as single cells and any subsequent re-measurement breaks
  // pairing (visible as broken `?`-style glyphs). All restore paths
  // (replayTerminalLayout → splitPane/createInitialPane → openTerminal,
  // restoreScrollbackBuffers, handleReattachResult) run after openTerminal,
  // so the activation must stay at this position.
  activateOrcaTerminalUnicodeProvider(terminal)

  // Why: any xterm character joiner makes every repaint scan the whole grid.
  // Defer registration until the first RTL write; replay and live paths both
  // ensure it before parsing, so restored Arabic still shapes immediately.
  pane.arabicShapingJoinerCleanup = configureLazyArabicShapingJoiner(
    terminal,
    () => pane.webglAddon != null
  )

  // Store so disposePane() can remove it and avoid a memory leak.
  pane.compositionHandler = installTerminalImeCandidateAnchor(terminal)

  pane.focusClassSyncCleanup = attachDomRendererFocusClassSync(terminal.element)

  if (pane.gpuRenderingEnabled) {
    attachWebgl(pane)
  }

  attachPaneFitResizeObserver(pane)

  // Initial fit (deferred to ensure layout has settled)
  if (pane.pendingInitialFitRafId != null) {
    cancelAnimationFrame(pane.pendingInitialFitRafId)
  }
  pane.pendingInitialFitRafId = requestAnimationFrame(() => {
    pane.pendingInitialFitRafId = null
    safeFit(pane)
  })
}

export function disposeLigatures(pane: ManagedPaneInternal): void {
  if (pane.ligaturesAddon) {
    try {
      pane.ligaturesAddon.dispose()
    } catch {
      /* ignore */
    }
    pane.ligaturesAddon = null
  }
}

export function attachLigatures(pane: ManagedPaneInternal): void {
  if (pane.ligaturesAddon) {
    return
  }
  try {
    const ligaturesAddon = new TerminalLigaturesAddon()
    pane.terminal.loadAddon(ligaturesAddon)
    pane.ligaturesAddon = ligaturesAddon
    // Why: ligatures can be enabled after rows already rendered, especially
    // from Settings. Force existing glyph runs to be recomputed immediately.
    if (!pane.webglAttachmentDeferred) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
    // Why: the WebGL renderer builds its glyph texture atlas at activation
    // time, so `font-feature-settings` applied after WebGL loaded won't
    // reach the GPU-rendered cells until the atlas is rebuilt. The upstream
    // docs call this out explicitly — reactivating WebGL after ligatures
    // forces a fresh atlas that includes the ligated glyphs.
    rebuildAttachedWebgl(pane)
  } catch (err) {
    console.warn('[terminal] ligatures addon failed to attach for pane', pane.id, err)
    pane.ligaturesAddon = null
  }
}

/** Enable or disable ligatures in-place, reusing the running terminal so the
 *  setting can be toggled without dropping scrollback or the PTY binding. */
export function setLigaturesEnabled(pane: ManagedPaneInternal, enabled: boolean): void {
  if (enabled) {
    attachLigatures(pane)
  } else if (pane.ligaturesAddon) {
    disposeLigatures(pane)
    // Why: ligatures lived inside the WebGL atlas, so after disposing the
    // addon the atlas still holds the ligated glyphs. Rebuild it so text
    // renders as the non-ligated fallback immediately.
    rebuildAttachedWebgl(pane)
  }
}

export type MovedPaneSplitState = {
  pane: ManagedPaneInternal
  scrollState: ReturnType<typeof captureScrollState>
  shouldReattachWebgl: boolean
}

export function runPaneCleanupStep(cleanupErrors: unknown[], cleanup: () => void): void {
  try {
    cleanup()
  } catch (error) {
    cleanupErrors.push(error)
  }
}

export function throwPaneCleanupErrors(cleanupErrors: unknown[], message: string): void {
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0]
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, message)
  }
}

export function preparePanesForSplitMove(
  sourceContainer: HTMLElement,
  fallbackPane: ManagedPaneInternal,
  panes: Map<number, ManagedPaneInternal>
): MovedPaneSplitState[] {
  const movedPanes: ManagedPaneInternal[] = []
  const appendPaneById = (paneIdValue: string | undefined): void => {
    const paneId = Number(paneIdValue)
    const pane = Number.isFinite(paneId) ? panes.get(paneId) : undefined
    if (pane && !movedPanes.includes(pane)) {
      movedPanes.push(pane)
    }
  }
  if (sourceContainer.classList.contains('pane')) {
    appendPaneById(sourceContainer.dataset.paneId)
  }
  for (const paneElement of sourceContainer.querySelectorAll<HTMLElement>('.pane[data-pane-id]')) {
    appendPaneById(paneElement.dataset.paneId)
  }
  if (movedPanes.length === 0) {
    movedPanes.push(fallbackPane)
  }

  return movedPanes.map((pane) => {
    // Why: chained reparenting can replace a pending WebGL reattach intent.
    const shouldReattachWebgl = !!pane.webglAddon || pane.pendingSplitWebglReattach === true
    clearPendingSplitScrollRestore(pane)
    const scrollState = captureScrollState(pane.terminal)
    // Why: this lock prevents fits from restoring scroll before split settling.
    pane.pendingSplitScrollState = scrollState
    // Why: DOM reparenting can invalidate WebGL without a contextlost event.
    disposeWebgl(pane)
    return { pane, scrollState, shouldReattachWebgl }
  })
}

type PaneCleanupLedger = { pending: (() => void)[]; releases: (() => void)[] }
type PaneCleanupField =
  | 'arabicShapingJoinerCleanup'
  | 'focusClassSyncCleanup'
  | 'ligaturesAddon'
  | 'linkifierHoverResetDisposable'
  | 'linkifierMouseLeaveResetDisposable'
  | 'linkifierWindowBlurResetDisposable'
  | 'paneDragCleanup'
  | 'paneMouseEnterHandler'
  | 'panePointerDownHandler'
  | 'pendingInitialFitRafId'
  | 'terminalScrollIntentDisposable'

const paneCleanupLedgers = new WeakMap<ManagedPaneInternal, PaneCleanupLedger>()
const disposedPanes = new WeakSet<ManagedPaneInternal>()

function trackPaneCleanupField<K extends PaneCleanupField>(
  ledger: PaneCleanupLedger,
  pane: ManagedPaneInternal,
  key: K,
  dispose: (resource: NonNullable<ManagedPaneInternal[K]>) => void
): void {
  const resource = pane[key]
  if (resource == null) {
    return
  }
  ledger.pending.push(() => dispose(resource))
  ledger.releases.push(() => {
    if (pane[key] === resource) {
      ;(pane as unknown as Record<PaneCleanupField, unknown>)[key] = null
    }
  })
}

export function runPaneCleanupLedger(cleanups: (() => void)[], message: string): void {
  const cleanupErrors: unknown[] = []
  const failedCleanups: (() => void)[] = []
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch (error) {
      cleanupErrors.push(error)
      failedCleanups.push(cleanup)
    }
  }
  cleanups.splice(0, cleanups.length, ...failedCleanups)
  throwPaneCleanupErrors(cleanupErrors, message)
}

function createPaneResourceCleanupLedger(pane: ManagedPaneInternal): PaneCleanupLedger {
  const ledger: PaneCleanupLedger = { pending: [], releases: [] }
  trackPaneCleanupField(ledger, pane, 'pendingInitialFitRafId', (frameId) =>
    cancelAnimationFrame(frameId)
  )
  trackPaneCleanupField(ledger, pane, 'panePointerDownHandler', (handler) =>
    pane.container.removeEventListener('pointerdown', handler)
  )
  trackPaneCleanupField(ledger, pane, 'paneMouseEnterHandler', (handler) =>
    pane.container.removeEventListener('mouseenter', handler)
  )
  trackPaneCleanupField(ledger, pane, 'paneDragCleanup', (cleanup) => cleanup())
  trackPaneCleanupField(ledger, pane, 'focusClassSyncCleanup', (cleanup) => cleanup())
  trackPaneCleanupField(ledger, pane, 'terminalScrollIntentDisposable', (item) => item.dispose())
  trackPaneCleanupField(ledger, pane, 'linkifierHoverResetDisposable', (item) => item.dispose())
  trackPaneCleanupField(ledger, pane, 'linkifierMouseLeaveResetDisposable', (item) =>
    item.dispose()
  )
  trackPaneCleanupField(ledger, pane, 'linkifierWindowBlurResetDisposable', (item) =>
    item.dispose()
  )
  trackPaneCleanupField(ledger, pane, 'arabicShapingJoinerCleanup', (cleanup) => cleanup())
  trackPaneCleanupField(ledger, pane, 'ligaturesAddon', (addon) => addon.dispose())
  ledger.pending.push(
    () => cancelPendingWebglRefresh(pane),
    () => detachPaneFitResizeObserver(pane),
    () => clearPendingSplitScrollRestore(pane),
    () => cancelDeferredScrollRestore(pane.terminal),
    () => disposeWebgl(pane),
    () => pane.searchAddon.dispose(),
    () => pane.serializeAddon.dispose(),
    () => pane.unicode11Addon.dispose(),
    () => pane.webLinksAddon.dispose(),
    () => pane.fitAddon.dispose(),
    () => pane.terminal.dispose()
  )
  ledger.releases.push(() => {
    pane.pendingWebglRefreshRafId = null
    pane.fitResizeObserver = null
    pane.pendingObservedFitRafId = null
    pane.webglAddon = null
  })
  return ledger
}

export function disposePane(
  pane: ManagedPaneInternal,
  panes: Map<number, ManagedPaneInternal>,
  options: { releaseOwnership?: boolean } = {}
): void {
  if (disposedPanes.has(pane)) {
    if (options.releaseOwnership !== false && panes.get(pane.id) === pane) {
      panes.delete(pane.id)
    }
    return
  }
  const ledger = paneCleanupLedgers.get(pane) ?? createPaneResourceCleanupLedger(pane)
  paneCleanupLedgers.set(pane, ledger)
  runPaneCleanupLedger(ledger.pending, `Pane ${pane.id} cleanup failed`)
  for (const release of ledger.releases) {
    release()
  }
  paneCleanupLedgers.delete(pane)
  // Why: a failed split can hand an already-disposed pane to the retained close
  // transaction; fixed xterm addons must not receive a second disposal.
  disposedPanes.add(pane)
  if (options.releaseOwnership !== false && panes.get(pane.id) === pane) {
    panes.delete(pane.id)
  }

}
