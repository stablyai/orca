type ProcessExit = { id: string; incarnationId?: string; ptySourceDisowned?: boolean }
let observe: ((payload: ProcessExit) => void) | undefined

export function installPtyProcessExitObserver(observer: (payload: ProcessExit) => void): void {
  observe = observer
}

export function observePtyProcessExit(payload: ProcessExit): void {
  if (
    payload.ptySourceDisowned ||
    payload.id.startsWith('remote:') ||
    payload.id.startsWith('ssh:')
  ) {
    return
  }
  try {
    observe?.(payload)
  } catch (error) {
    console.warn('[pty] could not observe process exit', error)
  }
}
