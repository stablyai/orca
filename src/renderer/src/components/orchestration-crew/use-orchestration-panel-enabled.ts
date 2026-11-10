export function useOrchestrationPanelEnabled(): boolean {
  // Suspended after repeated performance regressions; saved opt-ins must not mount producers.
  return false
}
