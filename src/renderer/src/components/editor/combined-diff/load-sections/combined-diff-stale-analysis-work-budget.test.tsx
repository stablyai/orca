// @vitest-environment happy-dom

import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type {
  GitDiffResult,
  GitDiffTextResult
} from '../../../../../../shared/git-diff-compare-types'
import { getLargeDiffRenderLimit } from '../../../../../../shared/large-diff-render-limit'
import type { DiffSection } from '../../diff-section-types'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffViewRestore } from '../remember-view/use-combined-diff-view-restore'
import {
  combinedDiffScrollAnchorCache,
  combinedDiffScrollTopCache,
  combinedDiffViewStateCache
} from '../remember-view/combined-diff-view-memory'
import { useCombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'
import { useCombinedDiffSectionRetry } from './use-combined-diff-section-retry'
import { withDiffSectionLoadTimeout } from './combined-diff-section-load-timeout'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./fetch-combined-diff-section', () => ({ fetchCombinedDiffSection: mocks.fetch }))
import { useCombinedDiffSectionLoader } from './use-combined-diff-section-loader'

const file: OpenFile = {
  id: 'diff',
  filePath: '/repo',
  relativePath: 'file.ts',
  worktreeId: 'wt',
  isDirty: false,
  language: 'typescript',
  mode: 'diff',
  diffSource: 'combined-uncommitted'
}
const entries = [
  { path: 'file.ts', status: 'modified' as const, area: 'unstaged' as const, added: 1 }
]
const entrySet: CombinedDiffEntrySet = {
  entries,
  uncommittedEntries: entries,
  allEntries: entries,
  branchCompare: null,
  commitCompare: null,
  commitEntries: [],
  entrySignature: 'one',
  hasUncommittedEntriesSnapshot: true,
  isAllMode: false,
  isBranchMode: false,
  isCommitMode: false,
  renderableBranchEntries: [],
  shouldAutoReloadFromGitStatus: false,
  treeMode: 'uncommitted'
}
type Viewer = { file: OpenFile; entrySet: CombinedDiffEntrySet; viewStateKey: string }
const viewer: Viewer = { file, entrySet, viewStateKey: 'first' }

function replacementViewer(viewStateKey: string): Viewer {
  const replacementEntries = [{ ...entries[0]!, path: 'next.ts' }]
  return {
    file: { ...file, relativePath: 'next.ts' },
    entrySet: {
      ...entrySet,
      entries: replacementEntries,
      allEntries: replacementEntries,
      uncommittedEntries: replacementEntries,
      entrySignature: viewStateKey
    },
    viewStateKey
  }
}

function useViewer(props: Viewer) {
  const [sections, setSections] = useState<DiffSection[]>([])
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [, setGeneration] = useState(0)
  const [, setSideBySide] = useState(false)
  const registry = useCombinedDiffSectionLoadRegistry(sections)
  const restore = useCombinedDiffViewRestore({
    entrySet: props.entrySet,
    gitStatusEntries: [],
    registry,
    setGeneration,
    setSectionHeights,
    setSections,
    setSideBySide,
    viewStateKey: props.viewStateKey
  })
  const loader = useCombinedDiffSectionLoader({
    entrySet: props.entrySet,
    file: props.file,
    registry,
    sectionCount: sections.length,
    setSectionHeights,
    setSections
  })
  const retry = useCombinedDiffSectionRetry({
    invalidateViewStateCache: restore.invalidateViewStateCache,
    registry,
    setSectionHeights,
    setSections
  })
  return { sections, setSections, sectionHeights, setSectionHeights, registry, loader, retry }
}

function deferredResult() {
  let resolve!: (result: GitDiffResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<GitDiffResult>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function textResult(originalContent: string, modifiedContent = ''): GitDiffTextResult {
  return {
    kind: 'text',
    originalContent,
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

function countBodyReads(body: string) {
  const original = String.prototype.charCodeAt
  const prefix = body.slice(0, 32)
  let count = 0
  let calls = 0
  const spy = vi.spyOn(String.prototype, 'charCodeAt')
  spy.mockImplementation(function (this: string, index: number) {
    if (this.length === body.length && this.startsWith(prefix)) {
      count += 1
    }
    // Keep the operation counter independent of the spy's growing per-call history.
    calls += 1
    if (calls % 1024 === 0) {
      spy.mockClear()
    }
    return original.call(this, index)
  })
  return { count: () => count, restore: () => spy.mockRestore() }
}

async function flushLoads(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function startViewer(props = viewer) {
  const hook = renderHook(useViewer, { initialProps: props })
  await flushLoads()
  expect(mocks.fetch).toHaveBeenCalledOnce()
  expect(mocks.fetch).toHaveBeenLastCalledWith({
    branchCompare: props.entrySet.branchCompare,
    commitCompare: props.entrySet.commitCompare,
    entry: props.entrySet.entries[0],
    file: props.file,
    isAllMode: props.entrySet.isAllMode,
    isBranchMode: props.entrySet.isBranchMode,
    isCommitMode: props.entrySet.isCommitMode
  })
  return hook
}

async function settle(
  pending: ReturnType<typeof deferredResult>,
  result: GitDiffResult
): Promise<void> {
  await act(async () => {
    pending.resolve(result)
    await Promise.resolve()
  })
}

function expectedSection(initial: DiffSection, result: GitDiffResult, error?: string): DiffSection {
  const largeDiffRenderLimit =
    !error && result.kind === 'text'
      ? (result.largeDiffRenderLimit ?? getLargeDiffRenderLimit(result))
      : null
  const prune = largeDiffRenderLimit?.limited === true
  return {
    ...initial,
    originalContent: result.kind === 'text' && !prune ? result.originalContent : '',
    modifiedContent: result.kind === 'text' && !prune ? result.modifiedContent : '',
    diffResult: prune ? { ...result, originalContent: '', modifiedContent: '' } : result,
    largeDiffRenderLimit,
    loading: false,
    error,
    contentGeneration: initial.contentGeneration
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  mocks.fetch.mockReset()
  combinedDiffViewStateCache.clear()
  combinedDiffScrollAnchorCache.clear()
  combinedDiffScrollTopCache.clear()
})

describe('combined diff discarded-result analysis budget', () => {
  it.each([512, 65_536, 1_048_576])(
    'does not scan %i characters from a replaced view',
    async (size) => {
      const body = 'stale body\n'.padEnd(size, 'x')
      const stale = deferredResult()
      const fresh = deferredResult()
      mocks.fetch.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
      const hook = await startViewer()
      const generation = hook.result.current.registry.generationRef.current
      hook.rerender(replacementViewer('replacement'))
      await flushLoads()
      const replacementSections = hook.result.current.sections
      const response = structuredClone(textResult(body))
      const reads = countBodyReads(body)
      await settle(stale, response)
      reads.restore()
      expect(hook.result.current.sections).toBe(replacementSections)
      expect(hook.result.current.sectionHeights).toEqual({})
      expect(hook.result.current.registry.generationRef.current).toBe(generation + 1)
      expect(hook.result.current.registry.loadedIndicesRef.current.size).toBe(0)
      expect(hook.result.current.registry.loadingIndicesRef.current.has(0)).toBe(true)
      expect(hook.result.current.registry.reloadTimersRef.current.size).toBe(0)
      expect(mocks.fetch).toHaveBeenCalledTimes(2)
      const next = textResult('current', 'current edited')
      await settle(fresh, next)
      expect(hook.result.current.sections).toEqual([expectedSection(replacementSections[0]!, next)])
      expect(reads.count()).toBe(0)
    }
  )

  it.each([512, 65_536, 1_048_576])(
    'skips %i discarded RPC characters and keeps the 300 ms reload',
    async (size) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const body = 'stale RPC\n'.padEnd(size, 'x')
      const stale = deferredResult()
      const fresh = deferredResult()
      const remoteViewer = { ...viewer, file: { ...file, runtimeEnvironmentId: 'remote-1' } }
      mocks.fetch.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
      const hook = await startViewer(remoteViewer)
      const initialSections = hook.result.current.sections
      hook.result.current.registry.renderedIndicesRef.current.add(0)
      hook.result.current.retry.requestSectionReload(0)
      expect(hook.result.current.registry.sectionLoadTokensRef.current.get(0)).toBe(1)
      expect(hook.result.current.registry.reloadTimersRef.current.size).toBe(0)
      const response = structuredClone(textResult(body))
      const reads = countBodyReads(body)
      await settle(stale, response)
      reads.restore()
      expect(hook.result.current.sections).toBe(initialSections)
      expect(hook.result.current.registry.sectionLoadTokensRef.current.get(0)).toBe(2)
      expect(hook.result.current.registry.loadedIndicesRef.current.size).toBe(0)
      expect(hook.result.current.registry.loadingIndicesRef.current.size).toBe(0)
      expect(hook.result.current.registry.reloadTimersRef.current.size).toBe(1)
      expect(mocks.fetch).toHaveBeenCalledOnce()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299)
      })
      expect(mocks.fetch).toHaveBeenCalledOnce()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      await flushLoads()
      expect(mocks.fetch).toHaveBeenCalledTimes(2)
      expect(hook.result.current.registry.reloadTimersRef.current.size).toBe(0)
      const next = textResult('new RPC', 'new RPC edited')
      await settle(fresh, next)
      expect(hook.result.current.sections).toEqual([expectedSection(initialSections[0]!, next)])
      expect(reads.count()).toBe(0)
    }
  )

  it('keeps synchronous token-reload reentry into a replacement generation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const body = 'reentrant obsolete\n'.padEnd(65_536, 'x')
    const stale = deferredResult()
    const fresh = deferredResult()
    mocks.fetch.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const hook = await startViewer()
    hook.result.current.registry.renderedIndicesRef.current.add(0)
    hook.result.current.retry.requestSectionReload(0)
    const requestReload = hook.result.current.registry.requestSectionReloadRef.current
    const reenter = vi.fn((index: number) => {
      requestReload(index)
      hook.rerender(replacementViewer('reentrant-replacement'))
    })
    hook.result.current.registry.requestSectionReloadRef.current = reenter
    const reads = countBodyReads(body)
    await settle(stale, textResult(body))
    await flushLoads()
    reads.restore()
    expect(reenter).toHaveBeenCalledExactlyOnceWith(0)
    expect(hook.result.current.sections[0]?.loading).toBe(true)
    expect(hook.result.current.sections[0]?.diffResult).toBeNull()
    expect(hook.result.current.registry.loadingIndicesRef.current.has(0)).toBe(true)
    expect(hook.result.current.registry.loadedIndicesRef.current.size).toBe(0)
    expect(hook.result.current.registry.sectionLoadTokensRef.current.size).toBe(0)
    expect(hook.result.current.registry.reloadTimersRef.current.size).toBe(0)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const initial = hook.result.current.sections[0]!
    const next = textResult('live replacement')
    await settle(fresh, next)
    expect(hook.result.current.sections).toEqual([expectedSection(initial, next)])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(reads.count()).toBe(0)
  })

  it.each(['offscreen', 'collapsed'])(
    'does not force a %s stale section to reload',
    async (visibility) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const body = 'obsolete hidden diff\n'.padEnd(4096, 'x')
      const pending = deferredResult()
      mocks.fetch.mockReturnValueOnce(pending.promise)
      const hook = await startViewer()
      if (visibility === 'collapsed') {
        act(() => {
          hook.result.current.setSections((sections) =>
            sections.map((section) => ({ ...section, collapsed: true }))
          )
        })
        hook.result.current.registry.renderedIndicesRef.current.add(0)
      }
      const sections = hook.result.current.sections
      hook.result.current.retry.requestSectionReload(0)
      const reads = countBodyReads(body)
      await settle(pending, textResult(body))
      reads.restore()
      expect(hook.result.current.sections).toBe(sections)
      expect(hook.result.current.registry.loadedIndicesRef.current.size).toBe(0)
      expect(hook.result.current.registry.loadingIndicesRef.current.size).toBe(0)
      expect(hook.result.current.registry.sectionLoadTokensRef.current.get(0)).toBe(2)
      expect(hook.result.current.registry.reloadTimersRef.current.size).toBe(0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(mocks.fetch).toHaveBeenCalledOnce()
      expect(reads.count()).toBe(0)
    }
  )
})

describe('combined diff live result compatibility', () => {
  const body = 'original body\n'.padEnd(512, 'a')
  const modified = 'modified body\n'.padEnd(128, 'b')
  const legacy = textResult(body, modified)
  const metadata: GitDiffResult = {
    ...legacy,
    largeDiffRenderLimit: getLargeDiffRenderLimit(legacy)
  }
  const hostLimitMetadata: GitDiffTextResult = {
    ...textResult(''),
    largeDiffRenderLimit: getLargeDiffRenderLimit(textResult('\n'.repeat(120_001)))
  }
  const responseCases: [string, GitDiffResult, boolean][] = [
    ['legacy', legacy, true],
    ['native wire shape', structuredClone(legacy), true],
    ['relay wire shape', structuredClone(legacy), true],
    ['supplied metadata', metadata, false],
    [
      'binary',
      {
        kind: 'binary',
        originalContent: body,
        modifiedContent: modified,
        originalIsBinary: true,
        modifiedIsBinary: false,
        isImage: true,
        mimeType: 'application/pdf',
        modifiedDeleted: true
      },
      false
    ],
    ['empty', textResult(''), true],
    ['line-limited legacy', textResult('\n'.repeat(120_001)), true],
    ['character-limited legacy', textResult('x'.repeat(6_000_001)), false],
    ['native limit metadata', structuredClone(hostLimitMetadata), false],
    ['relay limit metadata', structuredClone(hostLimitMetadata), false]
  ]

  it.each(responseCases)('preserves the complete %s result', async (_name, response, scansBody) => {
    const pending = deferredResult()
    mocks.fetch.mockReturnValueOnce(pending.promise)
    const hook = await startViewer()
    const initial = hook.result.current.sections[0]!
    const reads = countBodyReads(body)
    await settle(pending, response)
    reads.restore()
    expect(hook.result.current.sections).toEqual([expectedSection(initial, response)])
    if (hook.result.current.sections[0]?.largeDiffRenderLimit?.limited) {
      expect(hook.result.current.sections[0]?.diffResult).not.toBe(response)
    } else {
      expect(hook.result.current.sections[0]?.diffResult).toBe(response)
    }
    expect(hook.result.current.registry.loadedIndicesRef.current.has(0)).toBe(true)
    expect(hook.result.current.registry.loadingIndicesRef.current.size).toBe(0)
    expect(hook.result.current.sectionHeights).toEqual({})
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(reads.count()).toBe(scansBody && response.originalContent === body ? body.length : 0)
  })

  it('preserves section identity on unchanged reload and remeasures changed content once', async () => {
    const first = deferredResult()
    const unchanged = deferredResult()
    const changed = deferredResult()
    mocks.fetch
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(unchanged.promise)
      .mockReturnValueOnce(changed.promise)
    const hook = await startViewer()
    const initial = hook.result.current.sections[0]!
    await settle(first, legacy)
    const current = hook.result.current.sections
    act(() => {
      hook.result.current.setSectionHeights({ 0: 640, 1: 80 })
    })
    const heights = hook.result.current.sectionHeights
    hook.result.current.registry.loadedIndicesRef.current.delete(0)
    hook.result.current.loader.loadSection(0)
    await flushLoads()
    await settle(unchanged, structuredClone(legacy))
    expect(hook.result.current.sections).toBe(current)
    expect(hook.result.current.sectionHeights).toBe(heights)
    hook.result.current.registry.loadedIndicesRef.current.delete(0)
    hook.result.current.loader.loadSection(0)
    await flushLoads()
    const next = textResult('changed original', 'changed modified')
    await settle(changed, next)
    expect(hook.result.current.sections).toEqual([
      { ...expectedSection(initial, next), contentGeneration: 1 }
    ])
    expect(hook.result.current.sectionHeights).toEqual({ 1: 80 })
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it.each([new Error('  original remote failure  '), new Error(' '), 'rejected value'])(
    'keeps the existing rejection message for %s',
    async (error) => {
      const pending = deferredResult()
      mocks.fetch.mockReturnValueOnce(pending.promise)
      const hook = await startViewer()
      const initial = hook.result.current.sections[0]!
      await act(async () => {
        pending.reject(error)
        await Promise.resolve()
      })
      const message =
        error instanceof Error && error.message.trim() ? error.message : 'Unable to load diff.'
      expect(hook.result.current.sections).toEqual([
        expectedSection(initial, textResult(''), message)
      ])
      expect(hook.result.current.registry.loadedIndicesRef.current.has(0)).toBe(true)
      expect(hook.result.current.registry.loadingIndicesRef.current.size).toBe(0)
    }
  )

  it('preserves the actual 30 second deadline and clears its timer after failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = deferredResult()
    mocks.fetch.mockImplementationOnce(() => withDiffSectionLoadTimeout(pending.promise))
    const hook = await startViewer()
    const initial = hook.result.current.sections[0]!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999)
    })
    expect(hook.result.current.sections[0]?.loading).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(hook.result.current.sections).toEqual([
      expectedSection(initial, textResult(''), 'Diff did not finish loading.')
    ])
    expect(vi.getTimerCount()).toBe(0)
    await settle(pending, legacy)
    expect(hook.result.current.sections[0]?.error).toBe('Diff did not finish loading.')
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('keeps a stale rejection from changing the replacement load', async () => {
    const stale = deferredResult()
    const fresh = deferredResult()
    mocks.fetch.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const hook = await startViewer()
    hook.rerender(replacementViewer('failed-replacement'))
    await flushLoads()
    const sections = hook.result.current.sections
    await act(async () => {
      stale.reject(new Error('obsolete failure'))
      await Promise.resolve()
    })
    expect(hook.result.current.sections).toBe(sections)
    expect(hook.result.current.registry.loadingIndicesRef.current.has(0)).toBe(true)
    await settle(fresh, legacy)
    expect(hook.result.current.sections).toEqual([expectedSection(sections[0]!, legacy)])
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('still reloads after a token-stale rejection without publishing the obsolete error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stale = deferredResult()
    const fresh = deferredResult()
    mocks.fetch.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const hook = await startViewer()
    const sections = hook.result.current.sections
    hook.result.current.registry.renderedIndicesRef.current.add(0)
    hook.result.current.retry.requestSectionReload(0)
    await act(async () => {
      stale.reject(new Error('obsolete remote failure'))
      await Promise.resolve()
    })
    expect(hook.result.current.sections).toBe(sections)
    expect(hook.result.current.registry.reloadTimersRef.current.size).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    await flushLoads()
    await settle(fresh, legacy)
    expect(hook.result.current.sections).toEqual([expectedSection(sections[0]!, legacy)])
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('preserves a synchronous fetch failure', async () => {
    const failure = new Error('original synchronous failure')
    mocks.fetch.mockImplementationOnce(() => {
      throw failure
    })
    const hook = await startViewer()
    expect(hook.result.current.sections[0]?.error).toBe(failure.message)
    expect(hook.result.current.sections[0]?.diffResult).toEqual(textResult(''))
    expect(hook.result.current.sections[0]?.largeDiffRenderLimit).toBeNull()
    expect(hook.result.current.sections[0]?.loading).toBe(false)
    expect(hook.result.current.registry.loadedIndicesRef.current.has(0)).toBe(true)
    expect(hook.result.current.registry.loadingIndicesRef.current.size).toBe(0)
  })
})
