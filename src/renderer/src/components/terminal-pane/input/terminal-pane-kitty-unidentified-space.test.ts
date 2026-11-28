// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { openKittyPane } from './terminal-pane-input-test-harness'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

// The event Electron 43 delivers on Linux Wayland, as captured in #23215.
function dispatchUnidentifiedCtrlSpace(
  textarea: HTMLTextAreaElement,
  type: 'keydown' | 'keyup',
  isComposing = false
): void {
  const event = new KeyboardEvent(type, {
    key: 'Unidentified',
    code: 'Space',
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(event, 'keyCode', { value: 32 })
  // happy-dom ignores KeyboardEventInit.isComposing, but Chromium reports it.
  Object.defineProperty(event, 'isComposing', { value: isComposing })
  textarea.dispatchEvent(event)
}

it('sends Ctrl+Space to a Kitty-keyboard app when Chromium names the key Unidentified (#23215)', async () => {
  const { sent, textarea } = await openKittyPane()

  dispatchUnidentifiedCtrlSpace(textarea, 'keydown')
  dispatchUnidentifiedCtrlSpace(textarea, 'keyup')

  expect(sent).toEqual(['\x1b[32;5u', '\x1b[32;5:3u'])
})

it('releases that Ctrl+Space when an IME starts composing before the keyup', async () => {
  const { sent, textarea } = await openKittyPane()

  dispatchUnidentifiedCtrlSpace(textarea, 'keydown')
  dispatchUnidentifiedCtrlSpace(textarea, 'keyup', true)

  expect(sent).toEqual(['\x1b[32;5u', '\x1b[32;5:3u'])
})

it('leaves Unidentified Ctrl+Space to the legacy 0x00 encoding without Kitty flags', async () => {
  const { sent, textarea } = await openKittyPane('')

  dispatchUnidentifiedCtrlSpace(textarea, 'keydown')
  dispatchUnidentifiedCtrlSpace(textarea, 'keyup')

  expect(sent).toEqual(['\x00'])
})

it('leaves a plain Space to xterm', async () => {
  const { sent, textarea } = await openKittyPane()

  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
  )

  // xterm sends the space from this keydown on macOS; on Linux the pane leaves printable keys to the native text path, so nothing is sent yet.
  expect(sent.filter((data) => data !== ' ')).toEqual([])
})
