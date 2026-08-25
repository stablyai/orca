export const TERMINAL_PANE_OWNER_UNVERIFIED = 'terminal_pane_owner_unverified'
export const TERMINAL_SESSION_EXITED = 'terminal_session_exited'

export function isTerminalPaneOwnerUnverified(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value)
  return message.includes(TERMINAL_PANE_OWNER_UNVERIFIED)
}

export function isTerminalSessionExited(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value)
  return (
    message.includes(TERMINAL_SESSION_EXITED) ||
    message.includes('Terminal session exited:') ||
    (value instanceof Error && value.name === 'TerminalSessionExitedError')
  )
}
