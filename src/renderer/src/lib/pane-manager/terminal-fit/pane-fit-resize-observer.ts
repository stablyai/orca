import type { ManagedPane, ManagedPaneInternal } from '../pane-manager-types'
import '../pane-layout/pane-tree-ops'
import {
  cancelPendingSafeFitContinuations,
  flushPendingSafeFitContinuations
} from './pane-fit-continuation-registry'
import { clearPaneFitContinuationRetry } from './pane-fit-continuation-retry'
import {
  isEchoOfLastRowFlip,
  rowFlipToRemember,
  type AppliedRowFlip
} from './one-row-fit-oscillation'
import { safeFitAndThen } from './pane-fit'

type ProposedDimensions = {
  cols: number
  rows: number
}

type StableFitPane = ManagedPane &
  Partial<Pick<ManagedPaneInternal, 'xtermContainer' | 'pendingObservedFitRafId'>>

const MAX_STABILITY_FRAMES = 8
const pendingStableFitRafIds = new WeakMap<StableFitPane, number>()
const stableFitCallbacks = new WeakMap<StableFitPane, Set<() => void>>()
const lastAppliedRowFlip = new WeakMap<StableFitPane, AppliedRowFlip>()

function getPendingObservedFitRafId(pane: StableFitPane): number | null {
  return pane.pendingObservedFitRafId ?? pendingStableFitRafIds.get(pane) ?? null
}

function setPendingObservedFitRafId(pane: StableFitPane, id: number | null): void {
  if ('pendingObservedFitRafId' in pane) {
    pane.pendingObservedFitRafId = id
    return
  }
  if (id === null) {
    pendingStableFitRafIds.delete(pane)
  } else {
    pendingStableFitRafIds.set(pane, id)
  }
}

function getFitElement(pane: StableFitPane): HTMLElement {
  return pane.xtermContainer ?? pane.container
}

function getProposedDimensions(pane: StableFitPane): ProposedDimensions | null {
  try {
    return pane.fitAddon.proposeDimensions() ?? null
  } catch {
    return null
  }
}

function dimensionsEqual(a: ProposedDimensions | null, b: ProposedDimensions | null): boolean {
  return a?.cols === b?.cols && a?.rows === b?.rows
}

function terminalDimensionsEqual(pane: StableFitPane, dims: ProposedDimensions): boolean {
  return pane.terminal.cols === dims.cols && pane.terminal.rows === dims.rows
}

function hasVisibleFitGeometry(pane: StableFitPane): boolean {
  const rect = getFitElement(pane).getBoundingClientRect?.()
  return !rect || (rect.width > 0 && rect.height > 0)
}

function addStableFitCallback(pane: StableFitPane, callback: (() => void) | undefined): void {
  if (!callback) {
    return
  }
  const callbacks = stableFitCallbacks.get(pane) ?? new Set()
  callbacks.add(callback)
  stableFitCallbacks.set(pane, callbacks)
}

function flushStableFitCallbacks(pane: StableFitPane): void {
  const callbacks = stableFitCallbacks.get(pane)
  if (!callbacks) {
    return
  }
  stableFitCallbacks.delete(pane)
  for (const callback of callbacks) {
    callback()
  }
}

function finishStableFit(pane: StableFitPane): void {
  setPendingObservedFitRafId(pane, null)
  const proposed = getProposedDimensions(pane)
  const current = { cols: pane.terminal.cols, rows: pane.terminal.rows }
  if (proposed && isEchoOfLastRowFlip(lastAppliedRowFlip.get(pane), current, proposed)) {
    // Fitting the reverse of the row just applied is the cell-boundary echo (#20822).
    lastAppliedRowFlip.delete(pane)
    flushPendingSafeFitContinuations(pane)
    clearPaneFitContinuationRetry(pane)
    flushStableFitCallbacks(pane)
    return
  }
  const flip = proposed ? rowFlipToRemember(current, proposed) : null
  if (flip) {
    lastAppliedRowFlip.set(pane, flip)
  } else if (!proposed || proposed.cols !== current.cols || proposed.rows !== current.rows) {
    // A matching measurement keeps the latch. Clearing it would let the echo fit on the next pass.
    lastAppliedRowFlip.delete(pane)
  }
  // An equal grid still proves measurability and must release hidden reattach continuations.
  safeFitAndThen(pane, 'stable-pane-fit', () => flushStableFitCallbacks(pane))
}

export function requestStablePaneFit(pane: StableFitPane, onSettled?: () => void): void {
  addStableFitCallback(pane, onSettled)
  if (getPendingObservedFitRafId(pane) !== null) {
    return
  }
  if (!hasVisibleFitGeometry(pane)) {
    stableFitCallbacks.delete(pane)
    return
  }
  // Coalesce divider fits off pointermove; require a stable grid to avoid Windows sidebar/scrollbar wobble causing Codex SIGWINCH loops.
  let previous = getProposedDimensions(pane)
  let frameCount = 0
  const waitForStableGrid = (): void => {
    setPendingObservedFitRafId(
      pane,
      requestAnimationFrame(() => {
        if (!hasVisibleFitGeometry(pane)) {
          setPendingObservedFitRafId(pane, null)
          stableFitCallbacks.delete(pane)
          return
        }
        const next = getProposedDimensions(pane)
        frameCount += 1

        if (!next) {
          finishStableFit(pane)
          return
        }

        if (terminalDimensionsEqual(pane, next)) {
          finishStableFit(pane)
          return
        }

        if (dimensionsEqual(previous, next)) {
          finishStableFit(pane)
          return
        }

        previous = next
        if (frameCount >= MAX_STABILITY_FRAMES) {
          finishStableFit(pane)
          return
        }

        waitForStableGrid()
      })
    )
  }
  waitForStableGrid()
}

export function attachPaneFitResizeObserver(pane: ManagedPaneInternal): void {
  detachPaneFitResizeObserver(pane)

  if (typeof ResizeObserver === 'undefined') {
    return
  }

  const observer = new ResizeObserver(() => {
    requestStablePaneFit(pane)
  })

  observer.observe(pane.xtermContainer)
  pane.fitResizeObserver = observer
}

export function detachPaneFitResizeObserver(pane: ManagedPaneInternal): void {
  pane.fitResizeObserver?.disconnect()
  pane.fitResizeObserver = null

  const pendingObservedFitRafId = getPendingObservedFitRafId(pane)
  if (pendingObservedFitRafId !== null) {
    cancelAnimationFrame(pendingObservedFitRafId)
    setPendingObservedFitRafId(pane, null)
  }
  stableFitCallbacks.delete(pane)
  cancelPendingSafeFitContinuations(pane)
}
