// @vitest-environment happy-dom
import * as React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_BLOCK_BYTES,
  type AttachmentTextRequest
} from './attachment-text-source'
import { AttachmentTextViewport } from './attachment-text-viewport'
import { createAttachmentTextPreviewHook } from './use-attachment-text-preview'

const usePreview = createAttachmentTextPreviewHook(React)

function reader(size: number) {
  return vi.fn(async ({ offset, length }: AttachmentTextRequest) => {
    const bytes = Buffer.alloc(Math.min(length, size - offset), 'x')
    return {
      snapshot: 'a'.repeat(64),
      size,
      bytesRead: bytes.length,
      contentBase64: bytes.toString('base64'),
      eof: offset + bytes.length === size
    }
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([100 * ATTACHMENT_TEXT_BLOCK_BYTES, 1000 * ATTACHMENT_TEXT_BLOCK_BYTES, 50 * 1024 * 1024])(
  'keeps cached scroll work independent of a %i-byte attachment and still loads new rows',
  async (size) => {
    const read = reader(size)
    const counts = vi.spyOn(AttachmentTextSource.prototype, 'rowCount')
    const known = vi.spyOn(AttachmentTextSource.prototype, 'rowKnown')
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      const preview = usePreview('/scroll.txt', read)
      const layout = React.useMemo(
        () => new AttachmentTextViewport(preview.source, 20, 600, preview.revision),
        [preview.source, preview.revision]
      )
      return { preview, layout }
    })
    await waitFor(() => expect(result.current.preview.source.cachedBlock(0)).toBeDefined())
    const before = result.current
    const settledRenders = renders
    counts.mockClear()
    known.mockClear()
    read.mockClear()
    for (let pixel = 1; pixel <= 10; pixel++) {
      await act(async () => result.current.preview.demand(before.layout.window(pixel)))
    }
    expect(result.current.preview.revision).toBe(before.preview.revision)
    expect(result.current.layout).toBe(before.layout)
    expect(renders).toBe(settledRenders)
    expect(read).not.toHaveBeenCalled()
    expect(known).not.toHaveBeenCalled()
    expect(counts.mock.calls.length).toBeLessThanOrEqual(40)

    await act(async () => result.current.preview.demand({ block: 1, row: 0, rows: 1 }))
    await waitFor(() =>
      expect(result.current.preview.revision).toBeGreaterThan(before.preview.revision)
    )
    expect(read).toHaveBeenCalledOnce()
    expect(result.current.layout).not.toBe(before.layout)
    const top = result.current.layout.position({ block: 1, row: 0 })
    expect(result.current.layout.rows(top)[0]?.text).toBe('x'.repeat(256))
  }
)

it('publishes successful superseded work to a cached window once, including synchronous reentry', async () => {
  const read = reader(ATTACHMENT_TEXT_BLOCK_BYTES * 3)
  const release = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let held = false
  const source = new AttachmentTextSource('/held.txt', async (request) => {
    if (held) {
      started.resolve()
      await release.promise
    }
    return read(request)
  })
  try {
    await source.block(0)
    held = true
    const obsolete = vi.fn()
    source.requestViewport({ block: 0, row: 0, rows: source.rowCount(0) + 1 }, obsolete)
    await started.promise
    const ready = Promise.withResolvers<void>()
    const repeated = vi.fn()
    const latest = vi.fn(() => {
      source.requestViewport({ block: 0, row: 0, rows: 1 }, repeated)
      ready.resolve()
    })
    source.requestViewport({ block: 0, row: 0, rows: 1 }, latest)
    release.resolve()
    await ready.promise
    expect(obsolete).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
    expect(latest).toHaveBeenCalledWith()
    expect(repeated).not.toHaveBeenCalled()
    expect(source.rowKnown(1)).toBe(true)
    expect(source.cachedBlock(0)).toBeDefined()
    expect(read).toHaveBeenCalledTimes(2)
  } finally {
    release.resolve()
    source.dispose()
  }
})
