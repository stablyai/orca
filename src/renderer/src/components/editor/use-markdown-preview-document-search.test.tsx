// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'
import { MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS } from './markdown-preview-document-types'
import { useMarkdownPreviewDocumentSearch } from './use-markdown-preview-document-search'

afterEach(() => vi.useRealTimers())

describe('large preview search failure state', () => {
  it('settles Find locally after timeout and clears failure when a new query starts', async () => {
    vi.useFakeTimers()
    const transport = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null
    }
    const failure = vi.fn()
    const client = new MarkdownPreviewDocumentClient(transport, failure)
    const foundation = {
      query: 'needle',
      isSearchOpen: true,
      setMatchCount: vi.fn(),
      setActiveMatchIndex: vi.fn()
    }
    const { result, rerender, unmount } = renderHook(
      ({ query }) => useMarkdownPreviewDocumentSearch(client, { ...foundation, query }, true),
      { initialProps: { query: 'needle' } }
    )
    expect(result.current.pending).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS))
    expect(result.current.failed).toBe(true)
    expect(result.current.pending).toBe(false)
    expect(foundation.setMatchCount).toHaveBeenCalledWith(0)
    expect(foundation.setActiveMatchIndex).toHaveBeenCalledWith(-1)
    expect(failure).not.toHaveBeenCalled()
    expect(transport.terminate).not.toHaveBeenCalled()
    rerender({ query: 'different' })
    expect(result.current.failed).toBe(false)
    expect(result.current.pending).toBe(true)
    unmount()
    client.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})
