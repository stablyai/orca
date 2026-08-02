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
  observeCompositionStart: () => void
  observeCompositionInput: (data: string) => void
  observeCompositionEnd: (data: string) => void
  observeDeliveredInput: () => void
  dispose: () => void
} {
  let timeout: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let compositionActive = false
  let compositionHasInput = false
  let compositionDelivered = false

  const clear = (): void => {
    if (timeout !== null) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  const arm = (): void => {
    clear()
    timeout = setTimeout(() => {
      timeout = null
      if (!disposed) {
        args.onUndeliverable()
      }
    }, INPUT_DELIVERY_TIMEOUT_MS)
  }

  return {
    observeKeydown: (event) => {
      if (disposed || !expectsTerminalInput(event)) {
        return
      }
      arm()
    },
    observeCompositionStart: () => {
      if (disposed) {
        return
      }
      clear()
      compositionActive = true
      compositionHasInput = false
      compositionDelivered = false
    },
    observeCompositionInput: (data) => {
      if (!disposed && compositionActive && data.length > 0) {
        compositionHasInput = true
      }
    },
    observeCompositionEnd: (data) => {
      if (disposed || !compositionActive) {
        return
      }
      compositionActive = false
      const shouldArm = compositionHasInput && data.length > 0 && !compositionDelivered
      compositionHasInput = false
      compositionDelivered = false
      clear()
      if (shouldArm) {
        arm()
      }
    },
    observeDeliveredInput: () => {
      if (compositionActive) {
        compositionDelivered = true
      }
      clear()
    },
    dispose: () => {
      disposed = true
      compositionActive = false
      clear()
    }
  }
}
