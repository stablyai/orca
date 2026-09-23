export function canInspectAgentActivationInventory(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.api?.runtime?.call === 'function' &&
    typeof window.api?.pty?.listSessions === 'function'
  )
}
