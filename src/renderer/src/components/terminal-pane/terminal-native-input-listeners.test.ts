// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'
import { installTerminalNativeInputListeners } from './terminal-native-input-listeners'

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
})

function install(forgetOptionKeyLocationOnBlur = false, setOptionKeyLocation = vi.fn()) {
  const tracker = createTerminalNativeOnlyShortcutTracker()
  const dispose = installTerminalNativeInputListeners(window, tracker, setOptionKeyLocation, {
    forgetOptionKeyLocationOnBlur
  })
  disposers.push(dispose)
  return { tracker, setOptionKeyLocation }
}

describe('installTerminalNativeInputListeners', () => {
  it('tracks Option location from the modifier keydown and clears it on keyup', () => {
    const { setOptionKeyLocation } = install()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', location: 1 }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', location: 1 }))

    expect(setOptionKeyLocation.mock.calls).toEqual([[1], [0]])
  })

  it('retains the tracked Option side across blur when the caller does not opt into forgetting', () => {
    const { setOptionKeyLocation } = install(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', location: 2 }))
    window.dispatchEvent(new KeyboardEvent('blur'))

    expect(setOptionKeyLocation.mock.calls).toEqual([[2]])
  })

  it('forgets the tracked Option side on blur when the caller opts into forgetting', () => {
    const { setOptionKeyLocation } = install(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', location: 2 }))
    window.dispatchEvent(new KeyboardEvent('blur'))

    expect(setOptionKeyLocation.mock.calls).toEqual([[2], [0]])
  })

  it('disarms the native-only shortcut tracker on blur for either Option policy', () => {
    for (const forgetOptionKeyLocationOnBlur of [false, true]) {
      const { tracker } = install(forgetOptionKeyLocationOnBlur)
      tracker.armKeyDown({ key: ' ', code: 'Space' })

      window.dispatchEvent(new KeyboardEvent('blur'))
      const keypress = new KeyboardEvent('keypress', { cancelable: true, code: 'Space', key: ' ' })
      window.dispatchEvent(keypress)

      expect(keypress.defaultPrevented).toBe(false)
      disposers.pop()?.()
    }
  })

  it('does not update Option location for an IME-owned event', () => {
    const { setOptionKeyLocation } = install()
    const event = new KeyboardEvent('keydown', { key: 'Alt' })
    Object.defineProperty(event, 'keyCode', { value: 229 })

    window.dispatchEvent(event)

    expect(setOptionKeyLocation).not.toHaveBeenCalled()
  })

  it('suppresses only companions and text owned by the native shortcut', () => {
    const { tracker } = install()
    tracker.armKeyDown({ key: ' ', code: 'Space' })
    const keypress = new KeyboardEvent('keypress', {
      cancelable: true,
      code: 'Space',
      key: ' '
    })
    const beforeInput = new InputEvent('beforeinput', {
      cancelable: true,
      data: ' ',
      inputType: 'insertText'
    })
    const unrelatedInput = new InputEvent('beforeinput', {
      cancelable: true,
      data: '한',
      inputType: 'insertText'
    })

    window.dispatchEvent(keypress)
    window.dispatchEvent(beforeInput)
    window.dispatchEvent(unrelatedInput)

    expect(keypress.defaultPrevented).toBe(true)
    expect(beforeInput.defaultPrevented).toBe(true)
    expect(unrelatedInput.defaultPrevented).toBe(false)
  })

  it('removes every listener on dispose', () => {
    const { setOptionKeyLocation } = install()
    disposers.pop()?.()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', location: 2 }))

    expect(setOptionKeyLocation).not.toHaveBeenCalled()
  })
})
