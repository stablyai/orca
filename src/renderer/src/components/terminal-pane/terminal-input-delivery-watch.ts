type TerminalInputKeydown = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'keyCode' | 'metaKey' | 'repeat'
>

const INPUT_DELIVERY_TIMEOUT_MS = 500
const ASCII_LETTER_KEY = /^[A-Za-z]$/

function expectsTerminalInput(event: TerminalInputKeydown): boolean {
  if (
    event.repeat ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return false
  }
  // Candidate-selection keys and CJK punctuation can be IME-owned without event.isComposing.
  return ASCII_LETTER_KEY.test(event.key)
}

export function createTerminalInputDeliveryWatch(args: {
  onUndeliverable: () => void
}): {
  observeKeydown: (event: TerminalInputKeydown) => void
  observeDeliveredInput: () => void
  dispose: () => void
} {
  let timeout: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const clear = (): void => {
    if (timeout !== null) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  return {
    observeKeydown: (event) => {
      if (disposed || !expectsTerminalInput(event)) {
        return
      }
      clear()
      timeout = setTimeout(() => {
        timeout = null
        if (!disposed) {
          args.onUndeliverable()
        }
      }, INPUT_DELIVERY_TIMEOUT_MS)
    },
    observeDeliveredInput: clear,
    dispose: () => {
      disposed = true
      clear()
    }
  }
}
