// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// These paths use supplied file context without resolving its editor connection.
const boundaryMocks = vi.hoisted(() => ({
  getConnectionId: vi.fn(() => {
    throw new Error('These fixtures must not resolve editor connections')
  })
}))

vi.mock('@/lib/connection-context', () => ({ getConnectionId: boundaryMocks.getConnectionId }))

const editors: Editor[] = []

function makePasteEvent(text: string, html = ''): ClipboardEvent {
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  clipboardData.setData('text/html', html)
  return new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
}

function makeEditor(): {
  chunks: string[]
  editor: Editor
  setDestroyed: (destroyed: boolean) => void
  setFocused: (focused: boolean) => void
} {
  const editor = new Editor({ extensions: [StarterKit], content: '<p></p>' })
  document.body.append(editor.view.dom)
  editor.view.dom.focus()
  editors.push(editor)
  const chunks: string[] = []
  editor.on('transaction', ({ transaction }) => {
    if (transaction.docChanged) {
      chunks.push(transaction.doc.textContent.slice(transaction.before.textContent.length))
    }
  })
  return {
    chunks,
    editor,
    setDestroyed: (destroyed) => {
      if (destroyed) {
        editor.destroy()
      }
    },
    setFocused: (focused) => {
      if (focused) {
        editor.view.dom.focus()
      } else {
        const input = document.createElement('input')
        document.body.append(input)
        input.focus()
      }
    }
  }
}

async function flushPromises(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  try {
    expect(boundaryMocks.getConnectionId).not.toHaveBeenCalled()
  } finally {
    boundaryMocks.getConnectionId.mockClear()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  }
})

describe('rich markdown large text paste', () => {
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
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
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
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
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
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('hidden-token')
    expect(toast.info).not.toHaveBeenCalled()
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
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain(secret)
    expect(toast.info).not.toHaveBeenCalled()
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
    expect(toast.info).toHaveBeenCalledExactlyOnceWith('Large paste stopped before it finished.')
    expect(toast.error).not.toHaveBeenCalled()
  })
})
