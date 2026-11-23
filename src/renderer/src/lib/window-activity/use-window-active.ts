import { useEffect, useState } from 'react'

/** Whether this window is focused, shown and not minimized, as main reports it. Subscribes only
 *  while `enabled`, so windows that don't need it pay nothing; false while disabled. */
export function useWindowActive(enabled: boolean): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    const ui = window.api.ui
    // Why feature-detect: without main's report the caller keeps its still state.
    if (
      !enabled ||
      typeof ui.onWindowActiveChanged !== 'function' ||
      typeof ui.isWindowActive !== 'function'
    ) {
      return
    }
    let disposed = false
    const unsubscribe = ui.onWindowActiveChanged(setActive)
    void ui
      .isWindowActive()
      .then((value) => {
        if (!disposed) {
          setActive(value)
        }
      })
      .catch(() => setActive(false))
    return () => {
      disposed = true
      unsubscribe()
      // Why reset: a later re-enable must not act on an old value before main answers.
      setActive(false)
    }
  }, [enabled])
  return enabled && active
}
