import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { disposeClosedEditorModels } from './closed-editor-tab-disposal'
import {
  getDiffViewerMonacoModelPaths,
  getDiffViewerMonacoModelPathPrefixes,
  type MonacoModelRegistry
} from './diff-monaco-model-disposal'

const CLOSED_DIFF_TAB_COUNT = 100
const RETAINED_MODEL_COUNT = 320

type FakeModel = {
  path: string
  attached: boolean
  disposed: boolean
  dispose: () => void
  isAttachedToEditor: () => boolean
  uri: { toString: (skipEncoding?: boolean) => string }
}

type FakeRegistry = MonacoModelRegistry & {
  models: FakeModel[]
  counters: { getModelsCalls: number; uriToStringCalls: number }
}

function createRegistry(models: FakeModel[]): FakeRegistry {
  const counters = { getModelsCalls: 0, uriToStringCalls: 0 }
  const byPath = new Map(models.map((model) => [model.path, model]))
  for (const model of models) {
    model.uri.toString = () => {
      counters.uriToStringCalls += 1
      return model.path
    }
  }
  return {
    models,
    counters,
    Uri: { parse: (value: string) => value },
    editor: {
      getModel: (uri: unknown) => byPath.get(String(uri)) ?? null,
      getModels: () => {
        counters.getModelsCalls += 1
        return models
      }
    }
  }
}

function createModel(path: string, attached = false): FakeModel {
  const model: FakeModel = {
    path,
    attached,
    disposed: false,
    dispose: () => {
      model.disposed = true
    },
    isAttachedToEditor: () => model.attached,
    uri: { toString: () => path }
  }
  return model
}

function diffTab(id: string): OpenFile {
  return { id, mode: 'diff', filePath: `/repo/${id}.ts` } as OpenFile
}

/** Baseline quadratic scan: enumerate the full registry once per owned prefix in both URI forms. */
function disposeByPrefixPerTab(registry: FakeRegistry, prefixes: readonly string[]): void {
  for (const prefix of prefixes) {
    for (const model of registry.editor.getModels()) {
      const uriString = model.uri.toString(true)
      const encodedUriString = model.uri.toString()
      if (
        uriString === prefix ||
        uriString.startsWith(`${prefix}:`) ||
        encodedUriString === prefix ||
        encodedUriString.startsWith(`${prefix}:`)
      ) {
        if (!model.isAttachedToEditor()) {
          model.dispose()
        }
      }
    }
  }
}

/** Mix closed-tab models, attached models, generation suffixes and unrelated retained models. */
function buildScenario(): {
  closedTabs: OpenFile[]
  models: FakeModel[]
  prefixes: string[]
} {
  const closedTabs = Array.from({ length: CLOSED_DIFF_TAB_COUNT }, (_, i) => diffTab(`tab-${i}`))
  const models: FakeModel[] = []

  for (let i = 0; i < 60; i += 1) {
    const base = getDiffViewerMonacoModelPaths({
      modelKey: `tab-${i}`,
      generationSuffix: ''
    })
    models.push(createModel(base.originalModelPath, i % 10 === 0))
    models.push(createModel(base.modifiedModelPath))
    if (i % 3 === 0) {
      const regenerated = getDiffViewerMonacoModelPaths({
        modelKey: `tab-${i}`,
        generationSuffix: ':large-diff-generation:2'
      })
      models.push(createModel(regenerated.originalModelPath))
    }
  }

  for (let i = 0; models.length < RETAINED_MODEL_COUNT; i += 1) {
    const stillOpen = getDiffViewerMonacoModelPaths({
      modelKey: `open-tab-${i}`,
      generationSuffix: ''
    })
    models.push(createModel(stillOpen.originalModelPath))
    models.push(createModel(`/repo/src/file-${i}.ts`))
  }

  const prefixes = closedTabs.flatMap((tab) => {
    const { originalModelPathPrefix, modifiedModelPathPrefix } =
      getDiffViewerMonacoModelPathPrefixes(tab.id)
    return [originalModelPathPrefix, modifiedModelPathPrefix]
  })

  return { closedTabs, models, prefixes }
}

describe('disposeClosedEditorModels', () => {
  it('scans the model registry once per batch instead of twice per closed diff tab', () => {
    const batched = buildScenario()
    const batchedRegistry = createRegistry(batched.models)
    disposeClosedEditorModels(batchedRegistry, batched.closedTabs)

    const perTab = buildScenario()
    const perTabRegistry = createRegistry(perTab.models)
    disposeByPrefixPerTab(perTabRegistry, perTab.prefixes)

    expect(perTabRegistry.counters.getModelsCalls).toBe(CLOSED_DIFF_TAB_COUNT * 2)
    expect(perTabRegistry.counters.uriToStringCalls).toBe(
      CLOSED_DIFF_TAB_COUNT * 2 * perTab.models.length * 2
    )

    expect(batchedRegistry.counters.getModelsCalls).toBe(1)
    expect(batchedRegistry.counters.uriToStringCalls).toBeLessThanOrEqual(batched.models.length * 2)
  })

  it('disposes exactly the models the per-tab sweep disposed', () => {
    const batched = buildScenario()
    disposeClosedEditorModels(createRegistry(batched.models), batched.closedTabs)

    const perTab = buildScenario()
    disposeByPrefixPerTab(createRegistry(perTab.models), perTab.prefixes)

    const disposedPaths = (models: FakeModel[]): string[] =>
      models
        .filter((m) => m.disposed)
        .map((m) => m.path)
        .sort()

    expect(disposedPaths(batched.models)).toEqual(disposedPaths(perTab.models))
    expect(disposedPaths(batched.models).length).toBeGreaterThan(0)
    expect(batched.models.filter((m) => m.attached).every((m) => !m.disposed)).toBe(true)
    expect(
      batched.models.filter((m) => m.path.includes('open-tab-')).every((m) => !m.disposed)
    ).toBe(true)
  })

  // Parity alone misses prefix bleed when both tab-1 and tab-10 close; keep the longer ID open to expose accidental disposal.
  it('does not dispose a still-open tab whose id extends a closed tab id', () => {
    const closed = getDiffViewerMonacoModelPaths({ modelKey: 'tab-1', generationSuffix: '' })
    const stillOpen = getDiffViewerMonacoModelPaths({ modelKey: 'tab-10', generationSuffix: '' })
    const models = [
      createModel(closed.originalModelPath),
      createModel(closed.modifiedModelPath),
      createModel(stillOpen.originalModelPath),
      createModel(stillOpen.modifiedModelPath)
    ]

    // Exercise batched URI-boundary matching rather than the baseline’s per-prefix startsWith.
    disposeClosedEditorModels(createRegistry(models), [diffTab('tab-1'), diffTab('tab-2')])

    expect(models.filter((m) => m.disposed).map((m) => m.path)).toEqual([
      closed.originalModelPath,
      closed.modifiedModelPath
    ])
  })

  it('is a no-op when nothing closed', () => {
    const registry = createRegistry([createModel('diff:original:tab-1:tab-1')])
    disposeClosedEditorModels(registry, [])
    expect(registry.counters.getModelsCalls).toBe(0)
    expect(registry.models[0].disposed).toBe(false)
  })
})
