import { addAppKeyListener, removeAppKeyListener } from './app-keyboard-router'

type GuardedKey = Pick<KeyboardEvent, 'code'>

/**
 * Owns the rest of a key press Orca already consumed: its auto-repeats never reach the terminal,
 * where a held Escape would otherwise arrive as a stream of ESC bytes. The release is left to the
 * terminal's Kitty orphan-keyup guard, which already drops releases of presses xterm never
 * encoded. Ends on that release, on a fresh press of the same key (the release was missed), or
 * when the window loses focus, since an unfocused window never receives the release. It belongs to
 * the window, not to a pane, so closing the pane that consumed the press does not end it early.
 */
export function armKeyLifecycleGuard(consumed: GuardedKey): () => void {
  const { code } = consumed
  let armed = true
  const swallow = (event: KeyboardEvent): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== code) {
      return
    }
    if (event.repeat) {
      swallow(event)
      return
    }
    disarm()
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === code) {
      disarm()
    }
  }
  const disarm = (): void => {
    if (!armed) {
      return
    }
    armed = false
    removeAppKeyListener('keydown', onKeyDown)
    removeAppKeyListener('keyup', onKeyUp)
    window.removeEventListener('blur', disarm)
  }
  // The held key stays owned even if a new Escape owner appears before its release.
  addAppKeyListener('keydown', onKeyDown, { gesture: true })
  addAppKeyListener('keyup', onKeyUp)
  window.addEventListener('blur', disarm)
  return disarm
}
