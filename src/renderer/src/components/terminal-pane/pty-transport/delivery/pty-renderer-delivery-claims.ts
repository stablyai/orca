import { redactPtyIdForDiagnostics } from '../../../../../../shared/terminal/pty/diagnostics/pty-delivery-diagnostics'
import { recordTerminalFreezeBreadcrumb } from '../../render-health/diagnostics/terminal-freeze-breadcrumbs'

const hiddenClaims = new Map<string, { count: number; graphics: number }>()

type VisibilityClaim = { ptyId: string; visible: boolean }

declare const visibilityClaimOwnerBrand: unique symbol

/** The mounted transport holding a claim; only its reference is ever compared. */
export type RendererPtyVisibilityClaimOwner = object & {
  readonly [visibilityClaimOwnerBrand]?: never
}

const visibilityClaimsByOwner = new Map<RendererPtyVisibilityClaimOwner, VisibilityClaim>()
const visibleClaimCounts = new Map<string, number>()

function sendHiddenState(ptyId: string, hidden: boolean, retainGraphics = false): void {
  recordTerminalFreezeBreadcrumb(hidden ? 'renderer-gate-mark' : 'renderer-gate-unmark', {
    id: redactPtyIdForDiagnostics(ptyId)
  })
  const pty = (globalThis as { window?: Window }).window?.api?.pty
  if (retainGraphics) {
    pty?.setHiddenRendererPty?.(ptyId, hidden, true)
  } else {
    pty?.setHiddenRendererPty?.(ptyId, hidden)
  }
}

function sendVisibility(ptyId: string, visible: boolean): void {
  ;(globalThis as { window?: Window }).window?.api?.pty?.setRendererPtyVisible?.(ptyId, visible)
}

/**
 * Holds a hidden-delivery claim until the returned release function runs.
 * Main sees the first acquire, last release, and changes to aggregate graphics retention.
 */
export function acquireHiddenRendererPtyDeliveryClaim(
  ptyId: string,
  retainGraphics = false
): () => void {
  const claims = hiddenClaims.get(ptyId) ?? { count: 0, graphics: 0 }
  const wasRetaining = claims.graphics > 0
  claims.count += 1
  if (retainGraphics) {
    claims.graphics += 1
  }
  hiddenClaims.set(ptyId, claims)
  if (claims.count === 1 || (!wasRetaining && retainGraphics)) {
    sendHiddenState(ptyId, true, retainGraphics)
  }

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    if (hiddenClaims.get(ptyId) !== claims) {
      return
    }
    claims.count -= 1
    if (retainGraphics) {
      claims.graphics -= 1
    }
    if (claims.count === 0) {
      hiddenClaims.delete(ptyId)
      sendHiddenState(ptyId, false)
    } else if (retainGraphics && claims.graphics === 0) {
      sendHiddenState(ptyId, true)
    }
  }
}

/** Clears stale main state for a visible PTY without overriding another live
 * hidden owner that is still completing a pane-to-watcher handoff. */
export function declareRendererPtyDeliveryVisible(ptyId: string): void {
  if (!hiddenClaims.has(ptyId)) {
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
  owner: RendererPtyVisibilityClaimOwner,
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

export function releaseRendererPtyVisibilityClaim(owner: RendererPtyVisibilityClaimOwner): void {
  const previous = visibilityClaimsByOwner.get(owner)
  if (!previous) {
    return
  }
  visibilityClaimsByOwner.delete(owner)
  if (removeVisibleClaim(previous)) {
    sendVisibility(previous.ptyId, false)
  }
}
