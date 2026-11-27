// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openKittyPane } from './terminal-pane-input-test-harness'

// Chrome on Android with Samsung Keyboard (#50460): every letter arrives as a keyCode 229
// keydown followed by a composed insertText, and Backspace over a populated proxy arrives the
// same way with deleteContentBackward.
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36'

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID_UA)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function dispatchKey(
  textarea: HTMLTextAreaElement,
  type: 'keydown' | 'keyup',
  key: string,
  code: string,
  keyCode: number
): boolean {
  const event = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(event)
  return event.defaultPrevented
}

function dispatchInput(
  textarea: HTMLTextAreaElement,
  type: 'beforeinput' | 'input',
  inputType: string,
  data: string | null
): void {
  const event = new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput' })
  Object.defineProperty(event, 'inputType', { value: inputType })
  Object.defineProperty(event, 'data', { value: data })
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

it('sends a Samsung Keyboard letter that arrives as keyCode 229 plus a composed insertText', async () => {
  const { sent, textarea } = await openKittyPane('')

  dispatchKey(textarea, 'keydown', 'Unidentified', '', 229)
  dispatchInput(textarea, 'beforeinput', 'insertText', 'h')
  textarea.value = 'h'
  dispatchInput(textarea, 'input', 'insertText', 'h')
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', 'Unidentified', '', 229)
  await nextEventLoop()

  expect(sent.join('')).toBe('h')
})

it('sends a Samsung Keyboard Backspace that arrives as keyCode 229 plus deleteContentBackward', async () => {
  const { sent, textarea } = await openKittyPane('')

  // A word is already in the proxy, so the empty-proxy shortcut does not apply.
  textarea.value = 'ab'
  dispatchKey(textarea, 'keydown', 'Unidentified', '', 229)
  dispatchInput(textarea, 'beforeinput', 'deleteContentBackward', null)
  textarea.value = 'a'
  dispatchInput(textarea, 'input', 'deleteContentBackward', null)
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', 'Unidentified', '', 229)
  await nextEventLoop()

  expect(sent.join('')).toBe('\x7f')
})

it('presses Enter through the Kitty encoder when every key is an escape code', async () => {
  const { sent, textarea } = await openKittyPane('\x1b[>8u')

  dispatchKey(textarea, 'keydown', 'Unidentified', '', 229)
  dispatchInput(textarea, 'beforeinput', 'insertLineBreak', null)
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', 'Unidentified', '', 229)
  await nextEventLoop()

  // Report-all does not exempt Enter, so a bare \r would be the one key outside the mode.
  expect(sent.join('')).toBe('\x1b[13u')
})

it('reports Delete as the tilde form with its release when event types are on', async () => {
  const { sent, textarea } = await openKittyPane('\x1b[>10u')

  dispatchKey(textarea, 'keydown', 'Unidentified', '', 229)
  dispatchInput(textarea, 'beforeinput', 'deleteContentForward', null)
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', 'Unidentified', '', 229)
  await nextEventLoop()

  // Delete has no CSI-u spelling; it stays 3~ and owes the release, trailers unchanged.
  expect(sent.join('')).toBe('\x1b[3~' + '\x1b[3;1:3~')
})

it('reports Delete release under event types even without report-all', async () => {
  const { sent, textarea } = await openKittyPane('\x1b[>2u')

  dispatchKey(textarea, 'keydown', 'Unidentified', '', 229)
  dispatchInput(textarea, 'beforeinput', 'deleteContentForward', null)
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', 'Unidentified', '', 229)
  await nextEventLoop()

  expect(sent.join('')).toBe('\x1b[3~' + '\x1b[3;1:3~')
})

it('reports Backspace in CSI-u form with its release only under report-all', async () => {
  const { sent, textarea } = await openKittyPane('\x1b[>10u')

  textarea.value = 'ab'
  dispatchKey(textarea, 'keydown', 'Unidentified', '', 229)
  dispatchInput(textarea, 'beforeinput', 'deleteContentBackward', null)
  textarea.value = 'a'
  dispatchInput(textarea, 'input', 'deleteContentBackward', null)
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', 'Unidentified', '', 229)
  await nextEventLoop()

  expect(sent.join('')).toBe('\x1b[127u' + '\x1b[127;1:3u')
})
