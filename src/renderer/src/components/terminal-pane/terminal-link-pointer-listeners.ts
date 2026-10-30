const CAPTURE = { capture: true } as const

/** Temporary observation for the one existing pointer transaction and its physical tail. */
export function createTerminalLinkPointerListeners(
  document: Document | undefined,
  window: Window | null | undefined,
  callbacks: {
    replacePress: () => void
    captureMove: (event: MouseEvent) => void
    captureUp: (event: MouseEvent) => void
    checkDrag: (event: MouseEvent) => void
    invalidate: () => void
  }
) {
  let listeners: 'none' | 'transaction' | 'tail' = 'none'
  const remove = (): void => {
    document?.removeEventListener('mousedown', callbacks.replacePress, CAPTURE)
    document?.removeEventListener('mousemove', callbacks.captureMove, CAPTURE)
    document?.removeEventListener('mouseup', callbacks.captureUp, CAPTURE)
    document?.removeEventListener('mousemove', callbacks.checkDrag)
    document?.removeEventListener('mouseleave', callbacks.invalidate)
    window?.removeEventListener('blur', callbacks.invalidate)
    listeners = 'none'
  }
  const install = (tail: boolean): void => {
    const next = tail ? 'tail' : 'transaction'
    if (listeners === next) {
      return
    }
    remove()
    listeners = next
    document?.addEventListener('mousedown', callbacks.replacePress, CAPTURE)
    document?.addEventListener('mousemove', callbacks.captureMove, CAPTURE)
    document?.addEventListener('mouseup', callbacks.captureUp, CAPTURE)
    if (!tail) {
      document?.addEventListener('mousemove', callbacks.checkDrag)
      document?.addEventListener('mouseleave', callbacks.invalidate)
      window?.addEventListener('blur', callbacks.invalidate)
    }
  }
  return { remove, install }
}
