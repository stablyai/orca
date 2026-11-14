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
  // Gate only initial paint on readiness so rechecks/focus refreshes cannot collapse an already visible guide.
  if (!initialProbeComplete && !statusReady) {
    return false
  }
  // Keep the ready banner until explicit dismissal, including after setup completes.
  return true
}
