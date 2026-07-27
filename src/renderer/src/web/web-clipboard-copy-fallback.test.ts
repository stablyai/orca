import { describe, expect, it, vi } from 'vitest'
import { copyClipboardTextViaExecCommand } from './web-clipboard-copy-fallback'

type FakeTextarea = {
  value: string
  readOnly: boolean
  style: Record<string, string>
  select: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

type FakeDocOptions = {
  /** Whether execCommand('copy') dispatches a copy event (WebKit refuses when nothing is selected). */
  dispatchesCopyEvent?: boolean | (() => boolean)
  execCommandResult?: boolean
  execCommandThrows?: boolean
  /** Omit clipboardData to model a browser that dispatches copy with no data holder. */
  withClipboardData?: boolean
}

function createFakeDocument(options?: FakeDocOptions) {
  const textarea: FakeTextarea = {
    value: '',
    readOnly: false,
    style: {},
    select: vi.fn(),
    remove: vi.fn()
  }
  const previousFocus = { focus: vi.fn() }
  const listeners: ((event: unknown) => void)[] = []
  const clipboardData = { setData: vi.fn() }
  let selectionSelected = false
  textarea.select = vi.fn(() => {
    selectionSelected = true
  })

  const execCommand = vi.fn((command: string) => {
    if (options?.execCommandThrows) {
      throw new Error('execCommand denied')
    }
    if (command !== 'copy') {
      return false
    }
    const dispatches =
      typeof options?.dispatchesCopyEvent === 'function'
        ? options.dispatchesCopyEvent()
        : (options?.dispatchesCopyEvent ?? true)
    if (dispatches) {
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
    activeElement: previousFocus,
    createElement: vi.fn(() => textarea),
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
    body: { appendChild: vi.fn() }
  } as unknown as Document

  return {
    doc,
    textarea,
    previousFocus,
    execCommand,
    clipboardData,
    listeners,
    wasTextareaSelected: () => selectionSelected
  }
}

describe('copyClipboardTextViaExecCommand', () => {
  it('serves the text from the copy event without touching the DOM', () => {
    const { doc, clipboardData, execCommand, textarea } = createFakeDocument()

    expect(copyClipboardTextViaExecCommand('terminal selection', doc)).toBe(true)
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'terminal selection')
    expect(execCommand).toHaveBeenCalledWith('copy')
    // Why assert this: the whole point of the event path is that no helper node
    // is ever appended, so page scripts cannot observe the copied text.
    expect(doc.createElement).not.toHaveBeenCalled()
    expect(textarea.select).not.toHaveBeenCalled()
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

  it('falls back to the textarea when the browser dispatches no copy event', () => {
    // WebKit refuses execCommand('copy') when nothing is selected.
    let selected = false
    const fake = createFakeDocument({ dispatchesCopyEvent: () => selected })
    fake.textarea.select = vi.fn(() => {
      selected = true
    })

    expect(copyClipboardTextViaExecCommand('copy me', fake.doc)).toBe(true)
    expect(fake.textarea.value).toBe('copy me')
    expect(fake.textarea.select).toHaveBeenCalled()
    expect(fake.textarea.remove).toHaveBeenCalled()
  })

  it('falls back to the textarea when the copy event carries no clipboardData', () => {
    const { doc, textarea } = createFakeDocument({ withClipboardData: false })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(true)
    expect(textarea.value).toBe('copy me')
  })

  it('reports failure when execCommand reports failure on both paths', () => {
    const { doc, textarea } = createFakeDocument({ execCommandResult: false })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
    expect(textarea.remove).toHaveBeenCalled()
  })

  it('returns false and still cleans up when execCommand throws', () => {
    const { doc, textarea, previousFocus } = createFakeDocument({ execCommandThrows: true })

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
    expect(textarea.remove).toHaveBeenCalled()
    expect(previousFocus.focus).toHaveBeenCalled()
  })

  it('returns false when the document has no execCommand', () => {
    const doc = { body: {} } as unknown as Document

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
  })

  it('leaves focus and the page selection untouched on the copy-event path', () => {
    const { doc, previousFocus } = createFakeDocument()
    const selection = {
      rangeCount: 1,
      getRangeAt: vi.fn(),
      removeAllRanges: vi.fn(),
      addRange: vi.fn()
    }
    ;(doc as unknown as { getSelection: () => unknown }).getSelection = () => selection

    expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(true)
    expect(selection.removeAllRanges).not.toHaveBeenCalled()
    expect(previousFocus.focus).not.toHaveBeenCalled()
  })

  describe('textarea fallback path', () => {
    function createTextareaOnlyDocument(options?: { execCommandThrows?: boolean }) {
      let selected = false
      const fake = createFakeDocument({
        dispatchesCopyEvent: () => selected,
        execCommandThrows: options?.execCommandThrows
      })
      fake.textarea.select = vi.fn(() => {
        selected = true
      })
      return fake
    }

    it('removes the helper textarea and restores focus after copying', () => {
      const { doc, textarea, previousFocus } = createTextareaOnlyDocument()

      copyClipboardTextViaExecCommand('copy me', doc)

      expect(textarea.remove).toHaveBeenCalled()
      expect(previousFocus.focus).toHaveBeenCalled()
    })

    it('restores the previous DOM selection after copying', () => {
      const { doc } = createTextareaOnlyDocument()
      const clonedRange = { cloned: true }
      const selection = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => ({ cloneRange: vi.fn(() => clonedRange) })),
        removeAllRanges: vi.fn(),
        addRange: vi.fn()
      }
      ;(doc as unknown as { getSelection: () => unknown }).getSelection = () => selection

      expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(true)
      expect(selection.removeAllRanges).toHaveBeenCalled()
      expect(selection.addRange).toHaveBeenCalledWith(clonedRange)
    })

    it('restores focus before the selection so refocusing cannot collapse it', () => {
      // Why: focusing an input collapses the document selection into that input,
      // so restoring ranges first is silently undone (proved in Chromium/Firefox/WebKit).
      const order: string[] = []
      const fake = createTextareaOnlyDocument()
      const previousFocus = { focus: vi.fn(() => order.push('focus')) }
      ;(fake.doc as unknown as { activeElement: unknown }).activeElement = previousFocus
      const selection = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => ({ cloneRange: vi.fn(() => ({})) })),
        removeAllRanges: vi.fn(() => order.push('removeAllRanges')),
        addRange: vi.fn(() => order.push('addRange'))
      }
      ;(fake.doc as unknown as { getSelection: () => unknown }).getSelection = () => selection

      copyClipboardTextViaExecCommand('copy me', fake.doc)

      expect(order).toEqual(['focus', 'removeAllRanges', 'addRange'])
    })

    it('leaves the DOM selection alone when nothing was selected', () => {
      const { doc } = createTextareaOnlyDocument()
      const selection = {
        rangeCount: 0,
        getRangeAt: vi.fn(),
        removeAllRanges: vi.fn(),
        addRange: vi.fn()
      }
      ;(doc as unknown as { getSelection: () => unknown }).getSelection = () => selection

      expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(true)
      expect(selection.removeAllRanges).not.toHaveBeenCalled()
      expect(selection.addRange).not.toHaveBeenCalled()
    })

    it('restores the DOM selection even when execCommand throws', () => {
      const { doc } = createTextareaOnlyDocument({ execCommandThrows: true })
      const clonedRange = { cloned: true }
      const selection = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => ({ cloneRange: vi.fn(() => clonedRange) })),
        removeAllRanges: vi.fn(),
        addRange: vi.fn()
      }
      ;(doc as unknown as { getSelection: () => unknown }).getSelection = () => selection

      expect(copyClipboardTextViaExecCommand('copy me', doc)).toBe(false)
      expect(selection.addRange).toHaveBeenCalledWith(clonedRange)
    })
  })
})
