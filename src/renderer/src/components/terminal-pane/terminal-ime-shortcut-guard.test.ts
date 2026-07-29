import { describe, expect, it } from 'vitest'
import {
  createTerminalImeShortcutGuard,
  writeTerminalShortcutInPtyOrder
} from './terminal-ime-shortcut-guard'

/** The keydown macOS delivers for Shift+Enter while a syllable is composing. */
const COMMITTING_ENTER = { key: 'Enter', isComposing: true }
/** The second keydown Chromium delivers for the same physical press. */
const REAL_ENTER = { key: 'Enter', isComposing: false }

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function openGuard(): {
  guard: ReturnType<typeof createTerminalImeShortcutGuard>
  compose: () => void
  commit: () => void
} {
  const target = new EventTarget()
  return {
    guard: createTerminalImeShortcutGuard(target),
    compose: () => target.dispatchEvent(new Event('compositionstart')),
    commit: () => target.dispatchEvent(new Event('compositionend'))
  }
}

describe('terminal IME shortcut guard', () => {
  it('leaves a keystroke the IME owns to the IME', () => {
    const { guard, compose } = openGuard()
    compose()

    expect(guard.classifyKeydown({ key: 'Enter' })).toBe('ime-owned')
  })

  it('trusts the event marker when it never saw the composition start', () => {
    const { guard } = openGuard()

    expect(guard.classifyKeydown(COMMITTING_ENTER)).toBe('ime-owned')
  })

  it('takes the press that follows the commit as the real shortcut', () => {
    const { guard, compose, commit } = openGuard()
    compose()
    guard.classifyKeydown(COMMITTING_ENTER)
    commit()

    expect(guard.classifyKeydown(REAL_ENTER)).toBe('follows-ime-commit')
  })

  it('does not treat a plain Shift+Enter as a commit follow-up', () => {
    const { guard } = openGuard()

    expect(guard.classifyKeydown(REAL_ENTER)).toBe('plain')
  })

  it('lets the commit follow-up be claimed only once', () => {
    const { guard, compose, commit } = openGuard()
    compose()
    commit()
    guard.classifyKeydown(REAL_ENTER)

    expect(guard.classifyKeydown(REAL_ENTER)).toBe('plain')
  })

  it('does not carry a pending commit into the next composition', () => {
    const { guard, compose, commit } = openGuard()
    compose()
    commit()
    // Why: a session that starts without an intervening keydown proves xterm's
    // queued flush already ran, so deferring behind it would order against nothing.
    compose()

    expect(guard.classifyKeydown({ key: 'a' })).toBe('plain')
  })

  it('leaves keys outside the IME-owned set alone while composing', () => {
    const { guard, compose } = openGuard()
    compose()

    // Why: the input-source switch chord is pressed with an IME live, so
    // claiming every composing keystroke would disable the shortcut for it.
    expect(guard.classifyKeydown({ key: ' ' })).toBe('plain')
    expect(guard.classifyKeydown({ key: 'c' })).toBe('plain')
  })

  it('does not claim an IME-owned key outside any composition', () => {
    const { guard } = openGuard()

    // Why: an IME also reports keystrokes outside a composition — the first key
    // after a macOS input-source switch, and Sogou/fcitx candidate commits.
    // Claiming those drops the shortcut with no second press to redo it.
    expect(guard.classifyKeydown({ key: 'Enter' })).toBe('plain')
  })

  it('covers every shortcut key an IME can claim, not just Enter', () => {
    // Why: the measured double-keydown is not Enter-specific, and Ctrl+Backspace
    // and the Option+Arrow rules write bytes the same direct way.
    for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Escape']) {
      const { guard, compose } = openGuard()
      compose()

      expect(guard.classifyKeydown({ key })).toBe('ime-owned')
    }
  })

  it('stops tracking once disposed', () => {
    const { guard, compose } = openGuard()
    guard.dispose()
    compose()

    expect(guard.classifyKeydown({ key: 'Enter' })).toBe('plain')
  })

  it('writes ordinary shortcut bytes without deferring', () => {
    const written: string[] = []

    writeTerminalShortcutInPtyOrder('plain', () => written.push('\x1b\r'))

    expect(written).toEqual(['\x1b\r'])
  })

  it('holds a post-commit write until the composition has been flushed', async () => {
    const written: string[] = []

    writeTerminalShortcutInPtyOrder('follows-ime-commit', () => written.push('\x1b\r'))
    expect(written).toEqual([])
    await nextEventLoop()

    expect(written).toEqual(['\x1b\r'])
  })
})
