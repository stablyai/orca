// @vitest-environment happy-dom

import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type InsertTransaction = { text: string }

function makePasteEvent(text: string, html = ''): ClipboardEvent {
  const event = new Event('paste', {
    bubbles: true,
    cancelable: true
  }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : '')
    }
  })
  return event
}

function makeEditor(): {
  chunks: string[]
  editor: Editor
  setDestroyed: (destroyed: boolean) => void
  setFocused: (focused: boolean) => void
} {
  const dom = document.createElement('div')
  document.body.appendChild(dom)
  const chunks: string[] = []
  let destroyed = false
  let focused = true
  const editor = {
    get isDestroyed() {
      return destroyed
    },
    get state() {
      return {
        tr: {
          insertText: (text: string): InsertTransaction => ({ text })
        }
      }
    },
    view: {
      dom,
      hasFocus: () => focused,
      dispatch: (transaction: InsertTransaction): void => {
        chunks.push(transaction.text)
      }
    }
  } as unknown as Editor

  return {
    chunks,
    editor,
    setDestroyed: (next) => {
      destroyed = next
    },
    setFocused: (next) => {
      focused = next
    }
  }
}

async function flushPromises(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('rich markdown large text paste', () => {
  it('ignores small, empty, default-prevented, and missing-editor paste events', () => {
    const { editor, chunks } = makeEditor()
    const small = makePasteEvent('small')
    const empty = makePasteEvent('')
    const handled = makePasteEvent('x'.repeat(128))
    handled.preventDefault()

    expect(handleRichMarkdownLargeTextPaste(null, makePasteEvent('text'))).toBe(false)
    expect(handleRichMarkdownLargeTextPaste(editor, small, { directMaxBytes: 128 })).toBe(false)
    expect(handleRichMarkdownLargeTextPaste(editor, empty, { directMaxBytes: 1 })).toBe(false)
    expect(handleRichMarkdownLargeTextPaste(editor, handled, { directMaxBytes: 8 })).toBe(false)
    expect(small.defaultPrevented).toBe(false)
    expect(chunks).toEqual([])
  })

  it('inserts large plain text through chunked ProseMirror transactions', async () => {
    const { editor, chunks } = makeEditor()
    const text = 'ab😀cd\n'.repeat(6)
    const event = makePasteEvent(text)
    const yieldToEventLoop = vi.fn(async () => {})

    expect(
      handleRichMarkdownLargeTextPaste(editor, event, {
        directMaxBytes: 8,
        chunkMaxBytes: 10,
        yieldToEventLoop
      })
    ).toBe(true)
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
    expect(chunks.some((chunk) => /[\uD800-\uDBFF]$/.test(chunk))).toBe(false)
    expect(yieldToEventLoop).toHaveBeenCalledTimes(chunks.length - 1)
  })

  it('claims large plain-text paste before yielded preflight inserts editor content', async () => {
    const { editor, chunks } = makeEditor()
    const text = 'x'.repeat(32)
    const event = makePasteEvent(text)
    const yieldToEventLoop = vi.fn(async () => {})
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')

    expect(
      handleRichMarkdownLargeTextPaste(editor, event, {
        directMaxBytes: 4,
        chunkMaxBytes: 64,
        maxBytes: 64,
        measureYieldAfterCodeUnits: 8,
        yieldToEventLoop
      })
    ).toBe(true)

    expect(event.defaultPrevented).toBe(true)
    expect(chunks).toEqual([])
    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)

    await flushPromises()

    expect(chunks.join('')).toBe(text)
    expect(yieldToEventLoop).toHaveBeenCalled()
  })

  it('falls back to plain text when rich HTML is too large for synchronous parsing', async () => {
    const { editor, chunks } = makeEditor()
    const text = 'safe fallback'
    const html = '<p data-secret="hidden-token">'.repeat(12)
    const event = makePasteEvent(text, html)
    const yieldToEventLoop = vi.fn(async () => {})

    expect(
      handleRichMarkdownLargeTextPaste(editor, event, {
        directMaxBytes: 32,
        chunkMaxBytes: 8,
        yieldToEventLoop
      })
    ).toBe(true)
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(chunks.join('')).toBe(text)
    expect(chunks.join('')).not.toContain('hidden-token')
    expect(yieldToEventLoop).toHaveBeenCalledTimes(chunks.length - 1)
  })

  it('uses byte length, not string length, when deciding whether rich HTML is large', async () => {
    const { editor, chunks } = makeEditor()
    const event = makePasteEvent('fallback', 'é'.repeat(4))
    const yieldToEventLoop = vi.fn(async () => {})

    expect(
      handleRichMarkdownLargeTextPaste(editor, event, {
        directMaxBytes: 7,
        chunkMaxBytes: 4,
        yieldToEventLoop
      })
    ).toBe(true)
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(chunks.join('')).toBe('fallback')
    expect(yieldToEventLoop).toHaveBeenCalledTimes(1)
  })

  it('rejects large rich HTML without a plain-text fallback before editor parsing', () => {
    const { editor, chunks } = makeEditor()
    const html = '<div>hidden-token</div>'.repeat(12)
    const event = makePasteEvent('', html)

    expect(
      handleRichMarkdownLargeTextPaste(editor, event, {
        directMaxBytes: 32
      })
    ).toBe(true)

    expect(event.defaultPrevented).toBe(true)
    expect(chunks).toEqual([])
    expect(toast.error).toHaveBeenCalledWith('Paste is too large.')
    expect(
      JSON.stringify((toast.error as unknown as { mock: { calls: unknown[] } }).mock.calls)
    ).not.toContain('hidden-token')
  })

  it('rejects oversized rich-editor paste without logging or inserting content', async () => {
    const { editor, chunks } = makeEditor()
    const secret = 'secret-token'
    const event = makePasteEvent(secret)

    expect(
      handleRichMarkdownLargeTextPaste(editor, event, {
        directMaxBytes: 2,
        maxBytes: secret.length - 1
      })
    ).toBe(true)

    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(chunks).toEqual([])
    expect(toast.error).toHaveBeenCalledWith('Paste is too large.')
    expect(
      JSON.stringify((toast.error as unknown as { mock: { calls: unknown[] } }).mock.calls)
    ).not.toContain(secret)
  })

  it('rejects oversized multibyte rich-editor paste before inserting content', async () => {
    const { editor, chunks } = makeEditor()
    const event = makePasteEvent('😀'.repeat(8))

    expect(
      handleRichMarkdownLargeTextPaste(editor, event, {
        directMaxBytes: 2,
        maxBytes: 7
      })
    ).toBe(true)

    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(chunks).toEqual([])
    expect(toast.error).toHaveBeenCalledWith('Paste is too large.')
  })

  it('stops chunking when the editor is destroyed between chunks', async () => {
    const { editor, chunks, setDestroyed } = makeEditor()
    const text = 'abcdef'.repeat(6)
    const event = makePasteEvent(text)

    handleRichMarkdownLargeTextPaste(editor, event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop: async () => {
        setDestroyed(true)
      }
    })
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(chunks).toEqual(['abcdef'])
  })

  it('stops chunking when focus leaves the original editor target', async () => {
    const { editor, chunks, setFocused } = makeEditor()
    const text = 'abcdef'.repeat(6)
    const event = makePasteEvent(text)

    handleRichMarkdownLargeTextPaste(editor, event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop: async () => {
        setFocused(false)
      }
    })
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(chunks).toEqual(['abcdef'])
  })
})
