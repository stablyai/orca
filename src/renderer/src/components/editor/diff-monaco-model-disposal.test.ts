import { describe, expect, it, vi } from 'vitest'
import {
  disposeUnattachedDiffViewerMonacoModels,
  disposeUnattachedMonacoModelPaths,
  disposeUnattachedMonacoModelsByPathPrefix,
  getDiffViewerMonacoModelPathPrefixes,
  getDiffViewerMonacoModelPaths
} from './diff-monaco-model-disposal'

type FakeModel = {
  dispose: () => void
  isAttachedToEditor: () => boolean
  uri: { toString: (skipEncoding?: boolean) => string }
}

function createRegistry(models: Map<string, FakeModel>) {
  return {
    Uri: {
      parse: (value: string) => value
    },
    editor: {
      getModel: (uri: unknown) => models.get(String(uri)) ?? null,
      getModels: () => [...models.values()]
    }
  }
}

function createModel(
  modelPath: string,
  attached: boolean,
  dispose: () => void = () => {},
  decodedModelPath: string = modelPath
): FakeModel {
  return {
    dispose,
    isAttachedToEditor: () => attached,
    uri: {
      toString: (skipEncoding?: boolean) => (skipEncoding ? decodedModelPath : modelPath)
    }
  }
}

describe('diff Monaco model disposal', () => {
  it('derives original and modified model paths from explicit model keys', () => {
    expect(
      getDiffViewerMonacoModelPaths({
        modelKey: 'fallback',
        originalModelKey: 'head:path.ts',
        modifiedModelKey: 'worktree:path.ts',
        generationSuffix: ':large-diff-generation:2'
      })
    ).toEqual({
      originalModelPath: 'diff:original:fallback:head~3Apath.ts:large-diff-generation:2',
      modifiedModelPath: 'diff:modified:fallback:worktree~3Apath.ts:large-diff-generation:2'
    })
  })

  it('disposes only exact-path models that are no longer attached to an editor', () => {
    const detachedOriginalDispose = vi.fn()
    const attachedModifiedDispose = vi.fn()
    const models = new Map([
      [
        'diff:original:file.ts',
        createModel('diff:original:file.ts', false, detachedOriginalDispose)
      ],
      ['diff:modified:file.ts', createModel('diff:modified:file.ts', true, attachedModifiedDispose)]
    ])
    const monacoRegistry = createRegistry(models)

    disposeUnattachedDiffViewerMonacoModels(monacoRegistry, {
      originalModelPath: 'diff:original:file.ts',
      modifiedModelPath: 'diff:modified:file.ts'
    })

    expect(detachedOriginalDispose).toHaveBeenCalledOnce()
    expect(attachedModifiedDispose).not.toHaveBeenCalled()
  })

  it('disposes combined diff section models by exact path', () => {
    const originalDispose = vi.fn()
    const modifiedDispose = vi.fn()
    const unrelatedDispose = vi.fn()
    const models = new Map([
      [
        'diff-section:review:abc:0:original',
        createModel('diff-section:review:abc:0:original', false, originalDispose)
      ],
      [
        'diff-section:review:abc:0:modified',
        createModel('diff-section:review:abc:0:modified', false, modifiedDispose)
      ],
      [
        'diff-section:review:abc:1:modified',
        createModel('diff-section:review:abc:1:modified', false, unrelatedDispose)
      ]
    ])
    const monacoRegistry = createRegistry(models)

    disposeUnattachedMonacoModelPaths(monacoRegistry, [
      'diff-section:review:abc:0:original',
      'diff-section:review:abc:0:modified'
    ])

    expect(originalDispose).toHaveBeenCalledOnce()
    expect(modifiedDispose).toHaveBeenCalledOnce()
    expect(unrelatedDispose).not.toHaveBeenCalled()
  })

  it('disposes generated tab models by owned path prefix', () => {
    const baseDispose = vi.fn()
    const generatedDispose = vi.fn()
    const siblingDispose = vi.fn()
    const attachedDispose = vi.fn()
    const ownedPaths = getDiffViewerMonacoModelPaths({ modelKey: 'tab-1', generationSuffix: '' })
    const generatedPaths = getDiffViewerMonacoModelPaths({
      modelKey: 'tab-1',
      generationSuffix: ':large-diff-generation:2'
    })
    const attachedGeneratedPaths = getDiffViewerMonacoModelPaths({
      modelKey: 'tab-1',
      generationSuffix: ':large-diff-generation:3'
    })
    const siblingPaths = getDiffViewerMonacoModelPaths({ modelKey: 'tab-10', generationSuffix: '' })
    const models = new Map([
      [ownedPaths.originalModelPath, createModel(ownedPaths.originalModelPath, false, baseDispose)],
      [
        generatedPaths.originalModelPath,
        createModel(generatedPaths.originalModelPath, false, generatedDispose)
      ],
      [
        siblingPaths.originalModelPath,
        createModel(siblingPaths.originalModelPath, false, siblingDispose)
      ],
      [
        attachedGeneratedPaths.originalModelPath,
        createModel(attachedGeneratedPaths.originalModelPath, true, attachedDispose)
      ]
    ])
    const monacoRegistry = createRegistry(models)
    const { originalModelPathPrefix } = getDiffViewerMonacoModelPathPrefixes('tab-1')

    disposeUnattachedMonacoModelsByPathPrefix(monacoRegistry, originalModelPathPrefix)

    expect(baseDispose).toHaveBeenCalledOnce()
    expect(generatedDispose).toHaveBeenCalledOnce()
    expect(siblingDispose).not.toHaveBeenCalled()
    expect(attachedDispose).not.toHaveBeenCalled()
  })

  it('does not dispose colon-suffixed sibling tab models by prefix', () => {
    const ownedDispose = vi.fn()
    const siblingDispose = vi.fn()
    const ownedPaths = getDiffViewerMonacoModelPaths({
      modelKey: 'foo',
      originalModelKey: 'foo:bar',
      generationSuffix: ''
    })
    const siblingPaths = getDiffViewerMonacoModelPaths({
      modelKey: 'foo:bar',
      generationSuffix: ''
    })
    const models = new Map([
      [
        ownedPaths.originalModelPath,
        createModel(ownedPaths.originalModelPath, false, ownedDispose, ownedPaths.originalModelPath)
      ],
      [
        siblingPaths.originalModelPath,
        createModel(
          siblingPaths.originalModelPath,
          false,
          siblingDispose,
          siblingPaths.originalModelPath
        )
      ]
    ])
    const monacoRegistry = createRegistry(models)
    const { originalModelPathPrefix } = getDiffViewerMonacoModelPathPrefixes('foo')

    disposeUnattachedMonacoModelsByPathPrefix(monacoRegistry, originalModelPathPrefix)

    expect(ownedDispose).toHaveBeenCalledOnce()
    expect(siblingDispose).not.toHaveBeenCalled()
  })
})
