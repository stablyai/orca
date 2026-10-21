// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarkdownPreviewDocument } from './use-markdown-preview-document'
import type { MarkdownPreviewWorkerResult } from './markdown-preview-document-types'

class PreviewWorker extends EventTarget implements Worker {
  static instances: PreviewWorker[] = []
  onmessage: Worker['onmessage'] = null
  onerror: Worker['onerror'] = null
  onmessageerror: Worker['onmessageerror'] = null
  postMessage = vi.fn<(message: unknown) => void>()
  terminate = vi.fn()
  constructor() {
    super()
    PreviewWorker.instances.push(this)
  }
  reply(result: MarkdownPreviewWorkerResult): void {
    this.onmessage?.(new MessageEvent('message', { data: result }))
  }
  loaded(): void {
    this.reply({ id: 1, type: 'loaded', document: { blocks: [], toc: [] } })
  }
}

function harness(content = 'first') {
  return renderHook(({ content, enabled }) => useMarkdownPreviewDocument(content, enabled), {
    initialProps: { content, enabled: true }
  })
}
async function finish(worker: PreviewWorker): Promise<void> {
  await act(async () => worker.loaded())
}
async function advance(): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(150))
}

beforeEach(() => {
  vi.useFakeTimers()
  PreviewWorker.instances = []
  vi.stubGlobal('Worker', PreviewWorker)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('large Markdown revision ownership', () => {
  it('keeps the completed document and client readable until replacement completes', async () => {
    const { result, rerender, unmount } = harness()
    const first = PreviewWorker.instances[0]
    await finish(first)
    const ready = result.current
    rerender({ content: 'second', enabled: true })
    expect(result.current).toMatchObject({ status: 'ready', content: 'first', refreshing: true })
    if (ready.status !== 'ready' || result.current.status !== 'ready') {
      throw new Error('Expected completed preview')
    }
    expect(result.current.client).toBe(ready.client)
    expect(result.current.document).toBe(ready.document)
    expect(first.terminate).not.toHaveBeenCalled()
    await advance()
    const second = PreviewWorker.instances[1]
    expect(second.postMessage).toHaveBeenCalledWith({ id: 1, type: 'load', content: 'second' })
    await finish(second)
    expect(result.current).toMatchObject({ status: 'ready', content: 'second', refreshing: false })
    expect(first.terminate).toHaveBeenCalledOnce()
    expect(second.terminate).not.toHaveBeenCalled()
    unmount()
    expect(second.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('debounces edits and never retains more than a displayed and replacement worker', async () => {
    const { result, rerender } = harness()
    const first = PreviewWorker.instances[0]
    await finish(first)
    rerender({ content: 'second', enabled: true })
    rerender({ content: 'third', enabled: true })
    expect(PreviewWorker.instances).toHaveLength(1)
    await advance()
    const replacement = PreviewWorker.instances[1]
    expect(replacement.postMessage).toHaveBeenCalledWith({ id: 1, type: 'load', content: 'third' })
    const lateReply = replacement.onmessage
    rerender({ content: 'fourth', enabled: true })
    expect(replacement.terminate).toHaveBeenCalledOnce()
    await advance()
    const current = PreviewWorker.instances[2]
    await act(async () =>
      lateReply?.call(
        replacement,
        new MessageEvent('message', {
          data: { id: 1, type: 'loaded', document: { blocks: [], toc: [] } }
        })
      )
    )
    expect(result.current).toMatchObject({ status: 'ready', content: 'first', refreshing: true })
    expect(
      PreviewWorker.instances.filter((worker) => !worker.terminate.mock.calls.length)
    ).toHaveLength(2)
    await finish(current)
    expect(result.current).toMatchObject({ status: 'ready', content: 'fourth', refreshing: false })
    expect(first.terminate).toHaveBeenCalledOnce()
  })

  it('keeps the old view with an explicit refresh failure and recovers on the next edit', async () => {
    const { result, rerender } = harness()
    const first = PreviewWorker.instances[0]
    await finish(first)
    rerender({ content: 'second', enabled: true })
    await advance()
    await act(async () =>
      PreviewWorker.instances[1].reply({ id: 1, type: 'error', message: 'Too complex' })
    )
    expect(result.current).toMatchObject({
      status: 'ready',
      content: 'first',
      refreshing: true,
      refreshError: 'Too complex'
    })
    expect(first.terminate).not.toHaveBeenCalled()
    rerender({ content: 'third', enabled: true })
    expect(result.current.refreshError).toBeNull()
    await advance()
    await finish(PreviewWorker.instances[2])
    expect(result.current).toMatchObject({ status: 'ready', content: 'third', refreshError: null })
  })

  it('cancels a pending replacement when content returns to the displayed revision', async () => {
    const { result, rerender } = harness()
    await finish(PreviewWorker.instances[0])
    rerender({ content: 'second', enabled: true })
    await advance()
    rerender({ content: 'first', enabled: true })
    expect(PreviewWorker.instances[1].terminate).toHaveBeenCalledOnce()
    expect(result.current).toMatchObject({ status: 'ready', content: 'first', refreshing: false })
  })

  it('closes both workers on disable and restarts only when enabled again', async () => {
    const { result, rerender } = harness()
    await finish(PreviewWorker.instances[0])
    rerender({ content: 'second', enabled: true })
    await advance()
    rerender({ content: 'second', enabled: false })
    expect(result.current.status).toBe('loading')
    expect(
      PreviewWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)
    ).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    rerender({ content: 'second', enabled: true })
    await finish(PreviewWorker.instances[2])
    expect(result.current).toMatchObject({ status: 'ready', content: 'second' })
  })

  it('closes displayed and replacement workers on unmount without stale state updates', async () => {
    const { rerender, unmount } = harness()
    await finish(PreviewWorker.instances[0])
    rerender({ content: 'second', enabled: true })
    await advance()
    unmount()
    await act(async () => {})
    expect(
      PreviewWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)
    ).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('captures the displayed revision before swapping and advances only completed revisions', async () => {
    let displayedContent: string | null = null
    const captured: (string | null)[] = []
    const beforeSwap = () => captured.push(displayedContent)
    const { result, rerender } = renderHook(
      ({ content }) => {
        const state = useMarkdownPreviewDocument(content, true, beforeSwap)
        displayedContent = state.status === 'ready' ? state.content : null
        return state
      },
      { initialProps: { content: 'first' } }
    )
    await finish(PreviewWorker.instances[0])
    expect(result.current).toMatchObject({ revision: 1 })
    rerender({ content: 'second' })
    await advance()
    await finish(PreviewWorker.instances[1])
    expect(captured).toEqual([null, 'first'])
    expect(result.current).toMatchObject({ content: 'second', revision: 2 })
  })

  it('removes an unusable displayed client if its worker fails during replacement', async () => {
    const { result, rerender } = harness()
    const first = PreviewWorker.instances[0]
    await finish(first)
    rerender({ content: 'second', enabled: true })
    await advance()
    await act(async () => first.onerror?.(new ErrorEvent('error')))
    expect(result.current.status).toBe('loading')
    expect(first.terminate).toHaveBeenCalledOnce()
    await finish(PreviewWorker.instances[1])
    expect(result.current).toMatchObject({ status: 'ready', content: 'second', refreshError: null })
  })
  it('reenables the same content with a fresh worker after a failed replacement', async () => {
    const { result, rerender } = harness()
    await finish(PreviewWorker.instances[0])
    rerender({ content: 'second', enabled: true })
    await advance()
    await act(async () =>
      PreviewWorker.instances[1].reply({ id: 1, type: 'error', message: 'Too complex' })
    )
    rerender({ content: 'second', enabled: false })
    expect(result.current).toMatchObject({ status: 'loading', refreshError: null })
    rerender({ content: 'second', enabled: true })
    expect(result.current).toMatchObject({ status: 'loading', refreshError: null })
    expect(PreviewWorker.instances).toHaveLength(3)
    await finish(PreviewWorker.instances[2])
    expect(result.current).toMatchObject({ status: 'ready', content: 'second', refreshError: null })
  })
})
