export const TERMINAL_SESSION_STATE_SAVE_FAILED_CODE = 'ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED'

export const TERMINAL_SESSION_STATE_SAVE_FAILED_MESSAGE =
  'Orca could not save this terminal session because local storage is unavailable.'

export function createTerminalSessionStateSaveFailureMessage(): string {
  return `${TERMINAL_SESSION_STATE_SAVE_FAILED_CODE}: ${TERMINAL_SESSION_STATE_SAVE_FAILED_MESSAGE}`
}

export function isTerminalSessionStateSaveFailure(message: string): boolean {
  return (
    message.includes(TERMINAL_SESSION_STATE_SAVE_FAILED_CODE) ||
    message.includes('Failed to save terminal session state')
  )
}
