import { describe, expect, it, vi } from 'vitest'
import {
  registerEditorFrameFlush,
  runAfterEditorFramesFlush,
  type EditorFrameFlushResult
} from './editor-pending-flush'

function flushResult(fileIds: readonly string[]) {
  const settled: { value?: EditorFrameFlushResult } = {}
  runAfterEditorFramesFlush(fileIds, (result) => {
    settled.value = result
  })
  return settled
}

describe('runAfterEditorFramesFlush', () => {
  it('names the files whose frame kept edits back instead of reporting success', async () => {
    const unregisterA = registerEditorFrameFlush('a', () => Promise.resolve(false))
    const unregisterB = registerEditorFrameFlush('b', () => Promise.resolve(true))
    try {
      const settled = flushResult(['a', 'b'])
      await vi.waitFor(() => expect(settled.value).toBeDefined())
      expect(settled.value).toEqual({ deferred: true, blocked: new Set(['a']) })
    } finally {
      unregisterA()
      unregisterB()
    }
  })

  it('counts a rejected flush as blocked so a close cannot drop the draft', async () => {
    const unregister = registerEditorFrameFlush('a', () =>
      Promise.reject(new Error('frame refused'))
    )
    try {
      const settled = flushResult(['a'])
      await vi.waitFor(() => expect(settled.value).toBeDefined())
      expect(settled.value?.blocked).toEqual(new Set(['a']))
    } finally {
      unregister()
    }
  })

  it('runs synchronously with an empty blocked set when no frame view is mounted', () => {
    expect(flushResult(['a']).value).toEqual({
      deferred: false,
      blocked: new Set()
    })
  })
})
