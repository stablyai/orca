// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openKittyPane } from './terminal-pane-input-test-harness'

// Huawei Browser on a HarmonyOS PC (#36015): it names Windows and OpenHarmony but never Linux.
const ARKWEB_PC_UA =
  'Mozilla/5.0 (PC; OpenHarmony 6.1; Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36  ArkWeb/6.1.0.134 HuaweiBrowser/6.1.9.300'

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ARKWEB_PC_UA)
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
  // happy-dom drops keyCode from KeyboardEventInit; xterm and the IME policy read it.
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(event)
  return event.defaultPrevented
}

function dispatchInsertText(textarea: HTMLTextAreaElement, type: string, data: string): void {
  const event = new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput' })
  // happy-dom ignores these InputEventInit fields; Chromium reports them on the commit.
  Object.defineProperty(event, 'inputType', { value: 'insertText' })
  Object.defineProperty(event, 'data', { value: data })
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

it.each([
  ['a plain shell', ''],
  ['kitty report-all-keys mode', '\x1b[>11u']
])('sends a HarmonyOS ArkWeb pinyin commit to the PTY once under %s', async (_, kittyPush) => {
  const { sent, textarea } = await openKittyPane(kittyPush)

  // Trace recorded typing "nihao" then Space: no composition events, letters arrive as keyups only.
  for (const [key, code, keyCode] of [
    ['n', 'KeyN', 78],
    ['i', 'KeyI', 73],
    ['h', 'KeyH', 72],
    ['a', 'KeyA', 65],
    ['o', 'KeyO', 79]
  ] as const) {
    dispatchKey(textarea, 'keyup', key, code, keyCode)
    await nextEventLoop()
  }
  const commitKeydownPrevented = dispatchKey(textarea, 'keydown', '\u0000', '', 229)
  expect(commitKeydownPrevented).toBe(false)
  dispatchInsertText(textarea, 'beforeinput', '你好')
  textarea.value = '你好'
  dispatchInsertText(textarea, 'input', '你好')
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', '\u0000', '', 229)
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', ' ', 'Space', 32)
  await nextEventLoop()

  expect(sent.join('')).toBe('你好')
})
