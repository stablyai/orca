// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  dispatchImeInput,
  dispatchKey,
  nextEventLoop,
  openKittyPane
} from './terminal-pane-input-test-harness'

const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 16; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36'

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID_CHROME_UA)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

// Samsung Keyboard wraps each commit or deletion in a bare 229 keydown/keyup pair (#50460).
async function sendSoftKeyboardEdit(
  textarea: HTMLTextAreaElement,
  inputType: 'insertText' | 'deleteContentBackward',
  data: string | null,
  nextValue: string
): Promise<void> {
  dispatchKey(textarea, 'keydown', 'Unidentified', '', 229)
  dispatchImeInput(textarea, 'beforeinput', inputType, data)
  textarea.value = nextValue
  dispatchImeInput(textarea, 'input', inputType, data)
  dispatchKey(textarea, 'keyup', 'Unidentified', '', 229)
  await nextEventLoop()
}

it('sends Android soft-keyboard letters and Backspace to the PTY', async () => {
  const { sent, textarea } = await openKittyPane('')

  await sendSoftKeyboardEdit(textarea, 'insertText', 'h', 'h')
  await sendSoftKeyboardEdit(textarea, 'insertText', 'i', 'hi')
  await sendSoftKeyboardEdit(textarea, 'deleteContentBackward', null, 'h')

  expect(sent).toEqual(['h', 'i', '\x7f'])
})
