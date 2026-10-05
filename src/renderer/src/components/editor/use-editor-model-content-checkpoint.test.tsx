// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { Suspense } from 'react'
import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCheckpointModelFixture } from './editor-model-checkpoint-test-fixture'
import { useEditorModelContentCheckpoint } from './use-editor-model-content-checkpoint'
import { flushPendingEditorChange } from './editor-pending-flush'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
function fixture() {
  const first = createCheckpointModelFixture('first baseline')
  const second = createCheckpointModelFixture('second baseline')
  let model = first.model
  const listeners = new Set<Parameters<editor.ICodeEditor['onDidChangeModel']>[0]>()
  const editorInstance = {
    getModel: () => model,
    onDidChangeModel: (listener: Parameters<editor.ICodeEditor['onDidChangeModel']>[0]) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }
  }
  return {
    first,
    second,
    editorInstance,
    swap: () => {
      model = second.model
      listeners.forEach((listener) => listener({ oldModelUrl: null, newModelUrl: null }))
    }
  }
}

describe('checkpoint subscription ownership', () => {
  it('publishes pending text to the old committed owner before a file ID changes', () => {
    const f = fixture()
    const oldPublish = vi.fn()
    const nextPublish = vi.fn()
    const hook = renderHook(
      ({ fileId, publish }) =>
        useEditorModelContentCheckpoint({
          editor: f.editorInstance,
          enabled: true,
          fileId,
          publish
        }),
      { initialProps: { fileId: 'old-owner', publish: oldPublish } }
    )
    act(() => f.first.edit('pending old owner text'))
    hook.rerender({ fileId: 'next-owner', publish: nextPublish })
    expect(oldPublish).toHaveBeenCalledExactlyOnceWith('pending old owner text')
    expect(nextPublish).not.toHaveBeenCalled()
    act(() => f.first.edit('new owner text'))
    act(() => flushPendingEditorChange('next-owner'))
    expect(nextPublish).toHaveBeenCalledExactlyOnceWith('new owner text')
    expect(oldPublish).toHaveBeenCalledOnce()
  })

  it('never publishes an existing draft through callbacks from an abandoned render', () => {
    const f = fixture()
    const oldPublish = vi.fn()
    const nextPublish = vi.fn()
    const suspended = new Promise<void>(() => {})
    const hook = renderHook(
      ({ fileId, publish, suspend }) => {
        useEditorModelContentCheckpoint({
          editor: f.editorInstance,
          enabled: true,
          fileId,
          publish
        })
        if (suspend) {
          throw suspended
        }
      },
      {
        initialProps: { fileId: 'committed', publish: oldPublish, suspend: false },
        wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense>
      }
    )
    act(() => f.first.edit('pending committed text'))
    hook.rerender({ fileId: 'abandoned', publish: nextPublish, suspend: true })
    act(() => {
      flushPendingEditorChange('committed')
      vi.advanceTimersByTime(500)
    })
    expect(oldPublish).toHaveBeenCalledExactlyOnceWith('pending committed text')
    expect(nextPublish).not.toHaveBeenCalled()
  })

  it('flushes the previous model owner before a same-file ownership key changes', () => {
    const f = fixture()
    const previous = vi.fn()
    const next = vi.fn()
    const hook = renderHook(
      ({ ownerKey, publish }) =>
        useEditorModelContentCheckpoint({
          editor: f.editorInstance,
          enabled: true,
          fileId: 'same-file',
          ownerKey,
          publish
        }),
      { initialProps: { ownerKey: 'unresolved-host', publish: previous } }
    )
    act(() => f.first.edit('last input before owner resolves'))
    hook.rerender({ ownerKey: 'local-host', publish: next })
    expect(previous).toHaveBeenCalledExactlyOnceWith('last input before owner resolves')
    expect(next).not.toHaveBeenCalled()
  })

  it('flushes the old model rather than reading its replacement after a model swap', () => {
    const f = fixture()
    const publish = vi.fn()
    renderHook(() =>
      useEditorModelContentCheckpoint({
        editor: f.editorInstance,
        enabled: true,
        fileId: 'file',
        publish
      })
    )
    act(() => {
      f.first.edit('last old model edit')
      f.swap()
    })
    expect(publish).toHaveBeenCalledExactlyOnceWith('last old model edit')
    expect(f.second.model.getValue).not.toHaveBeenCalled()
    expect(f.first.listenerCount()).toBe(0)
    act(() => {
      f.second.edit('first new model edit')
      flushPendingEditorChange('file')
    })
    expect(publish).toHaveBeenLastCalledWith('first new model edit')
  })

  it('flushes before becoming read only and then removes its model listener', () => {
    const f = fixture()
    const publish = vi.fn()
    const hook = renderHook(
      ({ enabled }) =>
        useEditorModelContentCheckpoint({
          editor: f.editorInstance,
          enabled,
          fileId: 'file',
          publish
        }),
      { initialProps: { enabled: true } }
    )
    act(() => f.first.edit('final editable text'))
    hook.rerender({ enabled: false })
    expect(publish).toHaveBeenCalledExactlyOnceWith('final editable text')
    expect(f.first.listenerCount()).toBe(0)
    act(() => {
      f.first.edit('read only reload')
      vi.advanceTimersByTime(500)
    })
    expect(publish).toHaveBeenCalledOnce()
  })
})
