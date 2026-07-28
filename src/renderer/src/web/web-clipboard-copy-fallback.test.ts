import { describe, expect, it, vi } from 'vitest'
import { copyClipboardTextViaExecCommand } from './web-clipboard-copy-fallback'

type FakeDocOptions = {
  dispatchesCopyEvent?: boolean
  execCommandResult?: boolean
  execCommandThrows?: boolean
  withClipboardData?: boolean
}

function createFakeDocument(options?: FakeDocOptions) {
  const listeners: ((event: unknown) => void)[] = []
  const clipboardData = { setData: vi.fn() }
  const createElement = vi.fn()
  const appendChild = vi.fn()
  const execCommand = vi.fn((command: string) => {
    if (options?.execCommandThrows) {
      throw new Error('execCommand denied')
    }
    if (command !== 'copy') {
      return false
    }
    if (options?.dispatchesCopyEvent ?? true) {
      for (const listener of listeners.slice()) {
        listener({
          clipboardData: (options?.withClipboardData ?? true) ? clipboardData : undefined,
          preventDefault: vi.fn()
        })
      }
    }
    return options?.execCommandResult ?? true
  })
  const doc = {
    activeElement: { focus: vi.fn() },
    createElement,
    execCommand,
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      if (type === 'copy') {
        listeners.push(listener)
      }
    }),
    removeEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      if (type === 'copy') {
        const index = listeners.indexOf(listener)
        if (index >= 0) {
          listeners.splice(index, 1)
        }
      }
    }),
    body: { appendChild }
  } as unknown as Document

  return { doc, clipboardData, createElement, appendChild, execCommand, listeners }
}

describe('copyClipboardTextViaExecCommand', () => {
  it('serves the text from the copy event without touching the DOM', () => {
    const { doc, clipboardData, createElement, appendChild, execCommand } = createFakeDocument()

    expect(copyClipboardTextViaExecCommand('terminal selection', doc)).toBe(true)
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'terminal selection')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(createElement).not.toHaveBeenCalled()
    expect(appendChild).not.toHaveBeenCalled()
  })

  it('removes the copy listener after a successful copy', () => {
    const { doc, listeners } = createFakeDocument()

    copyClipboardTextViaExecCommand('copy me', doc)

    expect(listeners).toHaveLength(0)
  })

  it('removes the copy listener when execCommand throws', () => {
    const { doc, listeners } = createFakeDocument({ execCommandThrows: true })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
    expect(listeners).toHaveLength(0)
  })

  it('reports failure when no copy event is dispatched', () => {
    const { doc, createElement, appendChild } = createFakeDocument({ dispatchesCopyEvent: false })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
    expect(createElement).not.toHaveBeenCalled()
    expect(appendChild).not.toHaveBeenCalled()
  })

  it('reports failure when the copy event has no clipboardData', () => {
    const { doc } = createFakeDocument({ withClipboardData: false })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
  })

  it('reports failure when execCommand reports failure', () => {
    const { doc } = createFakeDocument({ execCommandResult: false })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
  })

  it('returns false when the document has no execCommand', () => {
    const doc = { addEventListener: vi.fn() } as unknown as Document

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
  })

  it('returns false when the document has no event listener API', () => {
    const doc = { execCommand: vi.fn() } as unknown as Document

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
  })

  it('leaves focus and the page selection untouched', () => {
    const { doc } = createFakeDocument()
    const focus = vi.fn()
    const selection = {
      rangeCount: 1,
      getRangeAt: vi.fn(),
      removeAllRanges: vi.fn(),
      addRange: vi.fn()
    }
    ;(doc as unknown as { activeElement: unknown }).activeElement = { focus }
    ;(doc as unknown as { getSelection: () => unknown }).getSelection = () => selection

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(true)
    expect(selection.removeAllRanges).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})
