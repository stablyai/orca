// @vitest-environment happy-dom

import { useMemo, useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { clearCombinedDiffViewMemory } from '../remember-view/combined-diff-view-cache'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type {
  GitDiffResult,
  GitDiffTextResult
} from '../../../../../../shared/git-diff-compare-types'
import type { DiffSection } from '../../diff-section-types'
import { useCombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { createCombinedDiffSectionIndexMap } from '../resolve-changes/combined-diff-section-identity'
import { useCombinedDiffViewRestore } from '../remember-view/use-combined-diff-view-restore'
import { useCombinedDiffViewPersist } from '../remember-view/use-combined-diff-view-persist'
import { useCombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'
import { useCombinedDiffSectionRetry } from './use-combined-diff-section-retry'
import { useCombinedDiffSectionRevalidation } from './use-combined-diff-section-revalidation'

const sectionFetch = vi.hoisted(() => vi.fn())
vi.mock('./fetch-combined-diff-section', () => ({
  fetchCombinedDiffSection: async (args: { operation: unknown }) => ({
    result: await sectionFetch(args),
    operation: args.operation
  })
}))
vi.mock('./combined-diff-section-connection', () => ({
  acquireCombinedDiffSectionOperation: () => ({ assertCurrent: () => undefined })
}))
import { useCombinedDiffSectionLoader } from './use-combined-diff-section-loader'

const mocks = { fetch: sectionFetch }

const file: OpenFile = {
  id: 'metadata-retention',
  filePath: '/repo',
  relativePath: 'Changes',
  worktreeId: 'wt',
  isDirty: false,
  language: 'plaintext',
  mode: 'diff',
  diffSource: 'combined-uncommitted'
}
const noBranchEntries = []

type Review = { status: GitStatusEntry[]; file: OpenFile; viewStateKey: string }

function useReview(props: Review) {
  const [sections, setSections] = useState<DiffSection[]>([])
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [generation, setGeneration] = useState(0)
  const [sideBySide, setSideBySide] = useState(false)
  const registry = useCombinedDiffSectionLoadRegistry(sections)
  const entrySet = useCombinedDiffEntrySet({
    file: props.file,
    gitStatusEntries: props.status,
    liveBranchEntries: noBranchEntries,
    sectionsRef: registry.sectionsRef
  })
  const restore = useCombinedDiffViewRestore({
    entrySet,
    file: props.file,
    gitStatusEntries: props.status,
    registry,
    setGeneration,
    setSectionHeights,
    setSections,
    setSideBySide,
    viewStateKey: props.viewStateKey
  })
  const loader = useCombinedDiffSectionLoader({
    entrySet,
    file: props.file,
    generation,
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
  const sectionIndexByKeyRef = useMemo(
    () => ({ current: createCombinedDiffSectionIndexMap(sections) }),
    [sections]
  )
  const signature = useCombinedDiffSectionRevalidation({
    file: props.file,
    gitStatusEntries: props.status,
    registry,
    requestSectionReload: retry.requestSectionReload,
    sectionIndexByKeyRef,
    sectionEntries: entrySet.entries,
    shouldAutoReloadFromGitStatus: entrySet.shouldAutoReloadFromGitStatus,
    treeMode: entrySet.treeMode
  })
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  useCombinedDiffViewPersist({
    combinedGitStatusSignature: signature,
    entryCount: entrySet.entries.length,
    entrySignature: entrySet.entrySignature,
    loadedIndicesRef: registry.loadedIndicesRef,
    memoryLeaseRef: restore.memoryLeaseRef,
    scrollContainerRef,
    sectionHeights,
    sections,
    sideBySide,
    viewStateKey: props.viewStateKey
  })
  return {
    sections,
    setSections,
    sectionHeights,
    setSectionHeights,
    generation,
    registry,
    loader,
    restore,
    retry
  }
}

function entries(count: number): GitStatusEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `file-${index}.ts`,
    area: 'unstaged',
    status: 'modified',
    added: 1
  }))
}

async function flush(count = 10): Promise<void> {
  await act(async () => {
    for (let index = 0; index < count * 12 + 30; index += 1) {
      await Promise.resolve()
    }
  })
}

function textResult(modifiedContent = 'after\n'): GitDiffTextResult {
  return {
    kind: 'text',
    originalContent: 'before\n',
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

function deferredResult() {
  let resolve!: (result: GitDiffResult) => void
  const promise = new Promise<GitDiffResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderReview(review: Review) {
  return renderHook(useReview, { initialProps: review })
}

async function visitAll(hook: ReturnType<typeof renderReview>, count: number): Promise<void> {
  const renderedIndices = hook.result.current.registry.renderedIndicesRef.current
  for (let index = 0; index < count; index += 1) {
    act(() => {
      hook.result.current.registry.renderedIndicesRef.current = new Set([index])
      hook.result.current.loader.loadSection(index)
    })
    await flush()
  }
  hook.result.current.registry.renderedIndicesRef.current = renderedIndices
}

async function advanceReloadTimer(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  await flush()
}

afterEach(() => {
  cleanup()
  clearCombinedDiffViewMemory()
  vi.useRealTimers()
  mocks.fetch.mockReset()
})

it('retains bodies, heights and a dirty draft through a metadata-only change and reopen', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.fetch.mockResolvedValue(textResult())
  const review: Review = { status: entries(3), file, viewStateKey: 'metadata-only' }
  const hook = renderReview(review)
  await visitAll(hook, 3)
  act(() => {
    hook.result.current.setSections((prev) =>
      prev.map((section, index) =>
        index === 0 ? { ...section, dirty: true, modifiedContent: 'draft' } : section
      )
    )
    hook.result.current.setSectionHeights({ 0: 200, 1: 200, 2: 200 })
  })
  const before = hook.result.current
  before.registry.renderedIndicesRef.current = new Set([0, 1, 2])
  mocks.fetch.mockClear()
  const updated: Review = {
    ...review,
    status: review.status.map((entry, index) =>
      index < 2 ? { ...entry, status: 'renamed', oldPath: 'prior.ts', added: 2 } : entry
    )
  }

  hook.rerender(updated)
  await advanceReloadTimer()
  expect(hook.result.current.generation).toBe(before.generation)
  expect(hook.result.current.sectionHeights).toBe(before.sectionHeights)
  expect(hook.result.current.sections[2]).toBe(before.sections[2])
  expect(hook.result.current.sections[0]).toMatchObject({
    dirty: true,
    modifiedContent: 'draft',
    status: 'renamed',
    added: 2
  })
  expect(mocks.fetch.mock.calls.map(([request]) => request.entry.path)).toEqual(['file-1.ts'])

  hook.unmount()
  mocks.fetch.mockClear()
  const reopened = renderReview(updated)
  await flush()
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(reopened.result.current.sections[0]?.modifiedContent).toBe('draft')
})

it('discards an in-flight read when the other area of its path changes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = deferredResult()
  mocks.fetch.mockReturnValueOnce(pending.promise).mockResolvedValue(textResult('current'))
  const initial = entries(2)
  const review: Review = {
    status: [initial[0]!, { ...initial[0]!, area: 'staged' }, initial[1]!],
    file,
    viewStateKey: 'other-area-in-flight'
  }
  const hook = renderReview(review)
  await flush()
  hook.result.current.registry.renderedIndicesRef.current.add(0)
  const generation = hook.result.current.generation
  hook.rerender({
    ...review,
    status: review.status.map((entry, index) => (index === 1 ? { ...entry, added: 2 } : entry))
  })
  await act(async () => {
    pending.resolve(textResult('obsolete'))
  })
  await flush()
  expect(hook.result.current.sections[0]?.modifiedContent).toBe('')
  await advanceReloadTimer()
  expect(hook.result.current.sections[0]?.modifiedContent).toBe('current')
  expect(hook.result.current.generation).toBe(generation)
})

it.each([
  {
    name: 'order',
    change: (review: Review): Review => ({ ...review, status: review.status.toReversed() })
  },
  {
    name: 'worktree owner',
    change: (review: Review): Review => ({
      ...review,
      file: { ...review.file, worktreeId: 'folder:other' }
    })
  }
])('uses the full reset when $name changes', async ({ name, change }) => {
  mocks.fetch.mockResolvedValue(textResult())
  const review: Review = { status: entries(3), file, viewStateKey: `fallback-${name}` }
  const hook = renderReview(review)
  await flush()
  const before = hook.result.current
  mocks.fetch.mockClear()
  const next = change(review)
  hook.rerender(next)
  await flush()
  expect(hook.result.current.generation).toBe(before.generation + 1)
  expect(hook.result.current.sections[0]).not.toBe(before.sections[0])
  expect(mocks.fetch.mock.calls[0]?.[0].file.worktreeId).toBe(next.file.worktreeId)
})

it('reloads a row whose submodule admission changes under an unchanged cache signature', async () => {
  mocks.fetch.mockResolvedValue(textResult())
  const review: Review = {
    status: [{ ...entries(1)[0]!, added: undefined }],
    file,
    viewStateKey: 'submodule-policy'
  }
  const hook = renderReview(review)
  await flush()
  hook.rerender({
    ...review,
    status: [
      {
        ...review.status[0]!,
        submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
      }
    ]
  })
  await flush()
  expect(hook.result.current.sections[0]?.loadOnDemand).toBe(false)
  expect(hook.result.current.sections[0]?.modifiedContent).toBe('after\n')
})
