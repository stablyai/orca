import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'

const hiddenClaimCounts = new Map<string, number>()

type VisibilityClaim = { ptyId: string; visible: boolean }

const visibilityClaimsByOwner = new Map<object, VisibilityClaim>()
const visibleClaimCounts = new Map<string, number>()

function sendHiddenState(ptyId: string, hidden: boolean): void {
  recordTerminalFreezeBreadcrumb(hidden ? 'renderer-gate-mark' : 'renderer-gate-unmark', {
    id: redactPtyIdForDiagnostics(ptyId)
  })
  ;(globalThis as { window?: Window }).window?.api?.pty?.setHiddenRendererPty?.(ptyId, hidden)
}

function sendVisibility(ptyId: string, visible: boolean): void {
  ;(globalThis as { window?: Window }).window?.api?.pty?.setRendererPtyVisible?.(ptyId, visible)
}

/**
 * Holds a hidden-delivery claim until the returned release function runs.
 * Main sees only the first-acquire/last-release transitions for each PTY.
 */
export function acquireHiddenRendererPtyDeliveryClaim(ptyId: string): () => void {
  const nextCount = (hiddenClaimCounts.get(ptyId) ?? 0) + 1
  hiddenClaimCounts.set(ptyId, nextCount)
  if (nextCount === 1) {
    sendHiddenState(ptyId, true)
  }

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const currentCount = hiddenClaimCounts.get(ptyId) ?? 0
    if (currentCount <= 1) {
      hiddenClaimCounts.delete(ptyId)
      sendHiddenState(ptyId, false)
      return
    }
    hiddenClaimCounts.set(ptyId, currentCount - 1)
  }
}

/** Clears stale main state for a visible PTY without overriding another live
 * hidden owner that is still completing a pane-to-watcher handoff. */
export function declareRendererPtyDeliveryVisible(ptyId: string): void {
  if (!hiddenClaimCounts.has(ptyId)) {
    sendHiddenState(ptyId, false)
  }
}

function removeVisibleClaim(claim: VisibilityClaim): boolean {
  if (!claim.visible) {
    return false
  }
  const currentCount = visibleClaimCounts.get(claim.ptyId) ?? 0
  if (currentCount <= 1) {
    visibleClaimCounts.delete(claim.ptyId)
    return true
  }
  visibleClaimCounts.set(claim.ptyId, currentCount - 1)
  return false
}

/**
 * Reports one mounted transport's visibility. Ref-counting by owner prevents
 * a retiring pane from hiding a PTY after its replacement has already bound.
 */
export function setRendererPtyVisibilityClaim(
  owner: object,
  ptyId: string,
  visible: boolean
): void {
  const previous = visibilityClaimsByOwner.get(owner)
  if (previous?.ptyId === ptyId && previous.visible === visible) {
    return
  }

  if (previous) {
    const becameHidden = removeVisibleClaim(previous)
    if (becameHidden && previous.ptyId !== ptyId) {
      sendVisibility(previous.ptyId, false)
    }
  }

  visibilityClaimsByOwner.set(owner, { ptyId, visible })
  if (visible) {
    const nextCount = (visibleClaimCounts.get(ptyId) ?? 0) + 1
    visibleClaimCounts.set(ptyId, nextCount)
    if (nextCount === 1) {
      sendVisibility(ptyId, true)
    }
    return
  }

  if (!visibleClaimCounts.has(ptyId)) {
    sendVisibility(ptyId, false)
  }
}

export function releaseRendererPtyVisibilityClaim(owner: object): void {
  const previous = visibilityClaimsByOwner.get(owner)
  if (!previous) {
    return
  }
  visibilityClaimsByOwner.delete(owner)
  if (removeVisibleClaim(previous)) {
    sendVisibility(previous.ptyId, false)
  }
}

/** Test seam: renderer reload naturally clears these module-scoped claims. */
export function _resetPtyRendererDeliveryClaimsForTest(): void {
  hiddenClaimCounts.clear()
  visibilityClaimsByOwner.clear()
  visibleClaimCounts.clear()
}
