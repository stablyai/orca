export type MobileEmulatorAgentSetupVisibilityInput = {
  dismissed: boolean
  initialProbeComplete: boolean
  isActive: boolean
  statusReady: boolean
}

export function shouldShowMobileEmulatorAgentSetupGuide({
  dismissed,
  initialProbeComplete,
  isActive,
  statusReady
}: MobileEmulatorAgentSetupVisibilityInput): boolean {
  if (!isActive || dismissed) {
    return false
  }
  // Why: only gate the first paint on probe readiness; in-panel Re-check and focus
  // refresh briefly set loading again and must not collapse the guide.
  if (!initialProbeComplete && !statusReady) {
    return false
  }
  // Why: when setup is already complete, keep a compact "ready" banner with Done
  // until the user explicitly dismisses it.
  return true
}
