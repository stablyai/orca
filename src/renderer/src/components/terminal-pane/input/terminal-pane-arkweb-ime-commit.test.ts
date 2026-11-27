// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  dispatchImeInput,
  dispatchKey,
  nextEventLoop,
  openKittyPane
} from './terminal-pane-input-test-harness'

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
  dispatchImeInput(textarea, 'beforeinput', 'insertText', '你好')
  textarea.value = '你好'
  dispatchImeInput(textarea, 'input', 'insertText', '你好')
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', '\u0000', '', 229)
  await nextEventLoop()
  dispatchKey(textarea, 'keyup', ' ', 'Space', 32)
  await nextEventLoop()

  expect(sent.join('')).toBe('你好')
})
