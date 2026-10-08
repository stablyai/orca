import { storageCapacityErrorCode } from './storage-capacity-error'

export const TERMINAL_SESSION_STATE_SAVE_FAILED_CODE = 'ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED'

export const TERMINAL_SESSION_STATE_SAVE_FAILED_MESSAGE =
  'Orca could not save this terminal session.'
const CAPACITY_MARKER = '[storage-capacity-exhausted]'

export function createTerminalSessionStateSaveFailureMessage(error?: unknown): string {
  const capacity = storageCapacityErrorCode(error) ? ` ${CAPACITY_MARKER}` : ''
  return `${TERMINAL_SESSION_STATE_SAVE_FAILED_CODE}: ${TERMINAL_SESSION_STATE_SAVE_FAILED_MESSAGE}${capacity}`
}

export function isTerminalSessionStorageCapacityFailure(message: string): boolean {
  return isTerminalSessionStateSaveFailure(message) && message.includes(CAPACITY_MARKER)
}

export function isTerminalSessionStateSaveFailure(message: string): boolean {
  return (
    message.includes(TERMINAL_SESSION_STATE_SAVE_FAILED_CODE) ||
    message.includes('Failed to save terminal session state')
  )
}
