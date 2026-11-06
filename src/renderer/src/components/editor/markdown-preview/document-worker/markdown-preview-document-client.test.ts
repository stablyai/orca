import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'
import {
  MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS,
  type MarkdownPreviewWorkerResult
} from './markdown-preview-document-types'

class WorkerTransport extends EventTarget implements Worker {
  onmessage: Worker['onmessage'] = null
  onerror: Worker['onerror'] = null
  onmessageerror: Worker['onmessageerror'] = null
  postMessage = vi.fn<(message: unknown) => void>()
  terminate = vi.fn()
  reply(result: MarkdownPreviewWorkerResult): void {
    this.onmessage?.(new MessageEvent('message', { data: result }))
  }
}

afterEach(() => vi.useRealTimers())
describe('Markdown preview worker ownership', () => {
  it('cancels a timed-out search without terminating a working preview', async () => {
    vi.useFakeTimers()
    const worker = new WorkerTransport()
    const failure = vi.fn()
    const client = new MarkdownPreviewDocumentClient(worker, failure)
    const search = client.request({ type: 'search', query: 'needle' }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS)
    expect(await search).toEqual(new Error('Preview search timed out.'))
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 2, type: 'cancel-search' })
    expect(worker.terminate).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled()
    worker.reply({ id: 1, type: 'search', matches: [], truncated: false })
    const blocks = client.request({ type: 'blocks', indices: [0] })
    worker.reply({ id: 3, type: 'blocks', blocks: [] })
    expect(await blocks).toMatchObject({ type: 'blocks' })
    expect(vi.getTimerCount()).toBe(0)
    client.close()
  })
})
