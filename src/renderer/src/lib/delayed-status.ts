/** How long a shown status stays up, so it cannot flash right at the show delay. */
export const STATUS_MIN_VISIBLE_MS = 400

/** The status a view should show, and the key it belongs to. */
export type ShownStatus<A> = {
  key: string
  value: A
}

export type DelayedStatus<A> = {
  /** Reports the real status for `key`. A new key drops the shown status at once. */
  update: (key: string, value: A | null) => void
  /** Cancels pending timers. A later `update` starts again from the real status. */
  dispose: () => void
}

/**
 * Turns a real status into the status a view shows. A status that clears within
 * `showDelayMs` is never shown; a shown status stays for at least `minVisibleMs`.
 * Values compare by identity, so use strings or other stable values.
 */
export function createDelayedStatus<A>(
  onChange: (shown: ShownStatus<A> | null) => void,
  options: { showDelayMs: number; minVisibleMs?: number }
): DelayedStatus<A> {
  const minVisibleMs = options.minVisibleMs ?? STATUS_MIN_VISIBLE_MS
  let key = ''
  let latest: A | null = null
  let shown: A | null = null
  // While hidden, this is the show delay. While shown, the minimum visible time.
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    clearTimeout(timer)
    timer = undefined
  }
  const hide = (): void => {
    shown = null
    onChange(null)
  }
  const show = (value: A): void => {
    shown = value
    onChange({ key, value })
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      if (latest === null) {
        hide()
      }
    }, minVisibleMs)
  }

  return {
    update: (nextKey, value) => {
      if (nextKey !== key) {
        key = nextKey
        clearTimer()
        if (shown !== null) {
          hide()
        }
      }
      if (shown !== null && latest === null && value !== null) {
        clearTimer()
        hide()
      }
      latest = value

      if (shown === null) {
        if (value === null) {
          clearTimer()
        } else if (timer === undefined) {
          timer = setTimeout(() => {
            timer = undefined
            if (latest !== null) {
              show(latest)
            }
          }, options.showDelayMs)
        }
        return
      }

      if (value !== null) {
        if (value !== shown) {
          show(value)
        }
      } else if (timer === undefined) {
        hide()
      }
    },
    dispose: clearTimer
  }
}
