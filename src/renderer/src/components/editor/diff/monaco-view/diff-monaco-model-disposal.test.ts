import { describe, expect, it, vi } from 'vitest'
import {
  disposeUnattachedMonacoModelsByPathPrefixes,
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

    disposeUnattachedMonacoModelsByPathPrefixes(monacoRegistry, [originalModelPathPrefix])

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

    disposeUnattachedMonacoModelsByPathPrefixes(monacoRegistry, [originalModelPathPrefix])

    expect(ownedDispose).toHaveBeenCalledOnce()
    expect(siblingDispose).not.toHaveBeenCalled()
  })
})
