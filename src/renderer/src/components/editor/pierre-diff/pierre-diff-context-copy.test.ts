// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installPierreContextualCopy } from './pierre-diff-context-copy'

const { success } = vi.hoisted(() => ({ success: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ keybindings: {} }) } }))
vi.mock('@/hooks/useShortcutLabel', () => ({ formatShortcutLabel: () => 'Ctrl+Alt+C' }))
vi.mock('../editor-shortcuts', () => ({
  editorShortcutMatches: (_: string, event: KeyboardEvent) =>
    event.key === 'c' && event.ctrlKey && event.altKey
}))

let dispose: () => void
const writeClipboardText = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  window.api = { ui: { writeClipboardText } } as never
})
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})

function setup() {
  const container = document.createElement('div')
  const host = document.createElement('diffs-container')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = '<div data-line="10">first\n</div><div data-line="11">second</div>'
  const first = root.children[0].firstChild!
  const last = root.children[1].firstChild!
  const range = document.createRange()
  range.setStart(first, 0)
  range.setEnd(last, 3)
  const selection = {
    anchorNode: last,
    focusNode: first,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => 'first\nsec'
  } as unknown as Selection
  Object.defineProperty(root, 'getSelection', { value: () => selection })
  container.append(host)
  document.body.append(container)
  dispose = installPierreContextualCopy(container, () => ({
    relativePath: 'file.ts',
    language: 'typescript'
  }))
  const copy = () =>
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true
      })
    )
  return { copy }
}

it('copies a backwards selection through the native bridge and confirms only after it succeeds', async () => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  writeClipboardText.mockReturnValue(pending)
  const { copy } = setup()
  expect(copy()).toBe(false)
  expect(writeClipboardText).toHaveBeenCalledWith(
    'File: file.ts\nLines: 10-11\n\n```ts\nfirst\nsec\n```'
  )
  expect(success).not.toHaveBeenCalled()
  resolve()
  await pending
  expect(success).toHaveBeenCalledWith('Context copied')
})

it('does not report success after disposal or a rejected clipboard write', async () => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  writeClipboardText.mockReturnValue(pending)
  const { copy } = setup()
  copy()
  dispose()
  resolve()
  await pending
  expect(success).not.toHaveBeenCalled()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failure = Promise.reject(new Error('clipboard unavailable'))
  writeClipboardText.mockReturnValue(failure)
  setup().copy()
  await failure.catch(() => undefined)
  await Promise.resolve()
  expect(success).not.toHaveBeenCalled()
  error.mockRestore()
})
