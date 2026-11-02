// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'

const monacoFixture = vi.hoisted(() => {
  const models = new Map<
    string,
    { dispose: ReturnType<typeof vi.fn>; isAttachedToEditor: () => boolean }
  >()
  return {
    models,
    monaco: {
      Uri: { parse: (value: string) => value },
      editor: {
        getModel: (path: string) => models.get(path) ?? null
      }
    }
  }
})

vi.mock('@/lib/monaco-setup', () => ({ monaco: monacoFixture.monaco }))

import { getDiffViewerMonacoModelPaths } from './diff-monaco-model-disposal'
import { useDiffViewerLargeDiffLifecycle } from './useDiffViewerLargeDiffLifecycle'

function detachedModel(): {
  dispose: ReturnType<typeof vi.fn>
  isAttachedToEditor: () => boolean
} {
  return { dispose: vi.fn(), isAttachedToEditor: () => false }
}

function diffEditorFixture(
  original: unknown,
  modified: unknown
): {
  current: editor.IStandaloneDiffEditor
  setModel: ReturnType<typeof vi.fn>
} {
  let models = { original, modified }
  const setModel = vi.fn((nextModels: typeof models) => {
    models = nextModels
  })
  return {
    current: {
      getModel: () => models,
      setModel
    } as unknown as editor.IStandaloneDiffEditor,
    setModel
  }
}

describe('useDiffViewerLargeDiffLifecycle', () => {
  it('resets the owning diff widget before disposing a superseded model', async () => {
    const modelKey = 'diff-tab'
    const paths = ['modified-v1', 'modified-v2'].map((modifiedModelKey) =>
      getDiffViewerMonacoModelPaths({
        modelKey,
        modifiedModelKey,
        generationSuffix: ''
      })
    )
    const supersededModel = detachedModel()
    const originalModel = detachedModel()
    const currentModel = detachedModel()
    monacoFixture.models.set(paths[0].originalModelPath, originalModel)
    monacoFixture.models.set(paths[0].modifiedModelPath, supersededModel)
    monacoFixture.models.set(paths[1].modifiedModelPath, currentModel)
    const retainedEditor = diffEditorFixture(originalModel, supersededModel)

    const hook = renderHook(
      ({ modifiedModelKey }) =>
        useDiffViewerLargeDiffLifecycle({
          limited: false,
          modelKey,
          modifiedModelKey,
          diffEditorRef: retainedEditor,
          onEnterFallback: vi.fn()
        }),
      { initialProps: { modifiedModelKey: 'modified-v1' } }
    )

    hook.rerender({ modifiedModelKey: 'modified-v2' })
    await act(() => Promise.resolve())

    expect(retainedEditor.setModel).toHaveBeenCalledWith({
      original: originalModel,
      modified: currentModel
    })
    expect(supersededModel.dispose).toHaveBeenCalledOnce()
    expect(retainedEditor.setModel.mock.invocationCallOrder[0]).toBeLessThan(
      supersededModel.dispose.mock.invocationCallOrder[0]
    )
  })

  it('disposes the pair a remounted view supersedes after content changed while unmounted', async () => {
    const modelKey = 'file-1::tab-1'
    const paths = ['v1', 'v2'].map((signature) =>
      getDiffViewerMonacoModelPaths({
        modelKey,
        modelOwnerKey: 'file-1',
        originalModelKey: `${modelKey}:original:${signature}`,
        modifiedModelKey: `${modelKey}:modified:${signature}`,
        generationSuffix: ''
      })
    )
    const staleOriginal = detachedModel()
    const staleModified = detachedModel()
    monacoFixture.models.set(paths[0].originalModelPath, staleOriginal)
    monacoFixture.models.set(paths[0].modifiedModelPath, staleModified)
    const mount = (signature: string) =>
      renderHook(() =>
        useDiffViewerLargeDiffLifecycle({
          limited: false,
          modelKey,
          modelOwnerKey: 'file-1',
          originalModelKey: `${modelKey}:original:${signature}`,
          modifiedModelKey: `${modelKey}:modified:${signature}`,
          diffEditorRef: { current: null },
          onEnterFallback: vi.fn()
        })
      )

    mount('v1').unmount()
    expect(staleOriginal.dispose).not.toHaveBeenCalled()
    mount('v2').unmount()
    await act(() => Promise.resolve())

    expect(staleOriginal.dispose).toHaveBeenCalledOnce()
    expect(staleModified.dispose).toHaveBeenCalledOnce()
  })
})
