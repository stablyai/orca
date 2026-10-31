import { useEffect, useState } from 'react'

/** Whether Cmd (Mac) or Ctrl (elsewhere) is held now, so a control can show what a modified click does. */
export function usePlatformModifierHeld(enabled: boolean, isMac: boolean): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!enabled) {
      return
    }
    // Read from every key event, so a keyup swallowed by another handler can't leave it stuck.
    const read = (event: KeyboardEvent): void => setHeld(isMac ? event.metaKey : event.ctrlKey)
    // Dictation tools can paste without the modifier's keyup, and a blurred window never sees one.
    const release = (): void => setHeld(false)
    window.addEventListener('keydown', read, true)
    window.addEventListener('keyup', read, true)
    window.addEventListener('paste', release, true)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', read, true)
      window.removeEventListener('keyup', read, true)
      window.removeEventListener('paste', release, true)
      window.removeEventListener('blur', release)
      setHeld(false)
    }
  }, [enabled, isMac])
  return enabled && held
}
