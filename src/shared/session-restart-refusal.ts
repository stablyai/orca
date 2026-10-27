/** Main rejected the restart before stopping the old process. */
export const SESSION_RESTART_REFUSED_BEFORE_STOP = 'session-restart-refused-before-stop'

export function sessionRestartRefusalError(reason: string): Error {
  return new Error(`${SESSION_RESTART_REFUSED_BEFORE_STOP}: ${reason}`)
}

/** Electron wraps IPC failures, so the marker may sit after `Error invoking remote method`. */
export function isSessionRestartRefusedBeforeStop(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.includes(`${SESSION_RESTART_REFUSED_BEFORE_STOP}:`)
}
