import { beforeEach, describe, expect, it } from 'vitest'
import {
  diffViewStateCache,
  editorSelectionCache,
  pdfViewPositionCache,
  scrollTopCache
} from '@/lib/scroll-cache'
import type { OpenFile } from '@/store/slices/editor'
import { disposeClosedEditorTabs } from './closed-editor-tab-disposal'
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

/** The pre-fix shape: one full registry scan, with both URI renderings, per owned prefix. */
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

/**
 * 100 closed diff tabs, of which 60 still hold retained models (some with a large-diff generation
 * suffix, some attached), plus 200 unrelated retained models from other tabs.
 */
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

  // Still-open tabs and plain edit models the sweep must not touch.
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

beforeEach(() => {
  scrollTopCache.clear()
  editorSelectionCache.clear()
  diffViewStateCache.clear()
  pdfViewPositionCache.clear()
})

describe('disposeClosedEditorTabs', () => {
  it('scans the model registry once per batch instead of twice per closed diff tab', () => {
    const batched = buildScenario()
    const batchedRegistry = createRegistry(batched.models)
    disposeClosedEditorTabs(batchedRegistry, batched.closedTabs)

    const perTab = buildScenario()
    const perTabRegistry = createRegistry(perTab.models)
    disposeByPrefixPerTab(perTabRegistry, perTab.prefixes)

    // Pre-fix: 2 scans per closed tab, each rendering both URI forms for every retained model.
    expect(perTabRegistry.counters.getModelsCalls).toBe(CLOSED_DIFF_TAB_COUNT * 2)
    expect(perTabRegistry.counters.uriToStringCalls).toBe(
      CLOSED_DIFF_TAB_COUNT * 2 * perTab.models.length * 2
    )

    expect(batchedRegistry.counters.getModelsCalls).toBe(1)
    expect(batchedRegistry.counters.uriToStringCalls).toBeLessThanOrEqual(batched.models.length * 2)
  })

  it('disposes exactly the models the per-tab sweep disposed', () => {
    const batched = buildScenario()
    disposeClosedEditorTabs(createRegistry(batched.models), batched.closedTabs)

    const perTab = buildScenario()
    disposeByPrefixPerTab(createRegistry(perTab.models), perTab.prefixes)

    const disposedPaths = (models: FakeModel[]): string[] =>
      models
        .filter((m) => m.disposed)
        .map((m) => m.path)
        .sort()

    expect(disposedPaths(batched.models)).toEqual(disposedPaths(perTab.models))
    expect(disposedPaths(batched.models).length).toBeGreaterThan(0)
    // Attached models survive, as does everything owned by a still-open tab.
    expect(batched.models.filter((m) => m.attached).every((m) => !m.disposed)).toBe(true)
    expect(
      batched.models.filter((m) => m.path.includes('open-tab-')).every((m) => !m.disposed)
    ).toBe(true)
  })

  it('sweeps pane-scoped cache entries for closed edit tabs in one pass per cache', () => {
    scrollTopCache.set('/repo/a.ts', 10)
    scrollTopCache.set('/repo/a.ts::pane-1', 20)
    scrollTopCache.set('/repo/a.ts:rich', 30)
    scrollTopCache.set('/repo/b.ts::pane-1', 40)
    editorSelectionCache.set('/repo/a.ts::pane-2', [] as never)
    pdfViewPositionCache.set('/repo/a.ts:pdf', {
      pageNumber: 1,
      top: 0,
      left: 0
    })
    pdfViewPositionCache.set('/repo/a.ts::pane-1:pdf', {
      pageNumber: 2,
      top: 0,
      left: 0
    })

    disposeClosedEditorTabs(createRegistry([]), [
      { id: '/repo/a.ts', mode: 'edit', filePath: '/repo/a.ts' } as OpenFile
    ])

    expect([...scrollTopCache.keys()]).toEqual(['/repo/b.ts::pane-1'])
    expect(editorSelectionCache.size).toBe(0)
    expect(pdfViewPositionCache.size).toBe(0)
  })

  it('drops diff view state and preview scroll entries for closed diff tabs', () => {
    diffViewStateCache.set('tab-1', {} as never)
    diffViewStateCache.set('tab-1::pane-1', {} as never)
    diffViewStateCache.set('tab-10', {} as never)
    scrollTopCache.set('tab-1:preview', 5)
    scrollTopCache.set('tab-1::pane-1', 6)

    disposeClosedEditorTabs(createRegistry([]), [diffTab('tab-1')])

    expect([...diffViewStateCache.keys()]).toEqual(['tab-10'])
    expect(scrollTopCache.size).toBe(0)
  })

  // Why this is not covered by the parity test above: `buildScenario` closes tab-0..tab-99, so
  // tab-10 is in the closed batch too. Prefix bleed from tab-1 would dispose tab-10's models, but
  // the per-tab oracle disposes them as well via tab-10's own prefix, so the two agree and the
  // assertion still passes. Isolating it needs a still-OPEN tab whose id extends a closed one.
  it('does not dispose a still-open tab whose id extends a closed tab id', () => {
    const closed = getDiffViewerMonacoModelPaths({ modelKey: 'tab-1', generationSuffix: '' })
    const stillOpen = getDiffViewerMonacoModelPaths({ modelKey: 'tab-10', generationSuffix: '' })
    const models = [
      createModel(closed.originalModelPath),
      createModel(closed.modifiedModelPath),
      createModel(stillOpen.originalModelPath),
      createModel(stillOpen.modifiedModelPath)
    ]

    // Batched entry point on purpose: the owned prefixes become a Set probed at the URI's own `:`
    // boundaries, which is a different predicate from the pre-batch per-prefix `startsWith`.
    disposeClosedEditorTabs(createRegistry(models), [diffTab('tab-1'), diffTab('tab-2')])

    expect(models.filter((m) => m.disposed).map((m) => m.path)).toEqual([
      closed.originalModelPath,
      closed.modifiedModelPath
    ])
  })

  it('is a no-op when nothing closed', () => {
    const registry = createRegistry([createModel('diff:original:tab-1:tab-1')])
    disposeClosedEditorTabs(registry, [])
    expect(registry.counters.getModelsCalls).toBe(0)
    expect(registry.models[0].disposed).toBe(false)
  })
})
