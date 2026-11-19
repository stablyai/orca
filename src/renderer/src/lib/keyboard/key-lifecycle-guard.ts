import { addAppKeyListener, removeAppKeyListener } from './app-keyboard-router'

type GuardedKey = Pick<KeyboardEvent, 'code'>

/**
 * Owns the rest of a key press Orca already consumed: its auto-repeats and its release never
 * reach the terminal (Kitty event-type mode reports releases to the PTY). Ends on that release,
 * on a fresh press of the same key (the release was missed), or when the window loses focus,
 * since an unfocused window never receives the release.
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
    if (event.code !== code) {
      return
    }
    swallow(event)
    disarm()
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
  addAppKeyListener('keydown', onKeyDown, { first: true })
  addAppKeyListener('keyup', onKeyUp, { first: true })
  window.addEventListener('blur', disarm)
  return disarm
}
