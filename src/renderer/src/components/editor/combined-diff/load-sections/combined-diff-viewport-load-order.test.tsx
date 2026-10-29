// @vitest-environment happy-dom

import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitDiffResult } from '../../../../../../shared/git-diff-compare-types'
import type { DiffSection } from '../../diff-section-types'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'
import { useCombinedDiffSectionLoader } from './use-combined-diff-section-loader'
import { useCombinedDiffSectionRetry } from './use-combined-diff-section-retry'

const transport = vi.hoisted(() => ({ diff: vi.fn() }))
vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitDiff: transport.diff,
  getRuntimeGitBranchDiff: transport.diff,
  getRuntimeGitCommitDiff: transport.diff
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  requireRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const file: OpenFile = {
  id: 'review',
  filePath: '/repo',
  relativePath: 'review',
  worktreeId: 'workspace',
  language: 'plaintext',
  isDirty: false,
  mode: 'diff',
  diffSource: 'combined-uncommitted'
}

function useReview({ count, rendered }: { count: number; rendered: number[] }) {
  const entrySet = useMemo<CombinedDiffEntrySet>(() => {
    const entries = Array.from({ length: count }, (_, index) => ({
      path: `${index}.ts`,
      status: 'modified' as const,
      area: 'unstaged' as const
    }))
    return {
      entries,
      uncommittedEntries: entries,
      allEntries: entries,
      commitEntries: [],
      renderableBranchEntries: [],
      branchCompare: null,
      commitCompare: null,
      entrySignature: `${count}`,
      hasUncommittedEntriesSnapshot: true,
      shouldAutoReloadFromGitStatus: false,
      isAllMode: false,
      isBranchMode: false,
      isCommitMode: false,
      treeMode: 'uncommitted'
    }
  }, [count])
  const [sections, setSections] = useState<DiffSection[]>(() =>
    entrySet.entries.map((entry) => ({
      ...entry,
      key: entry.path,
      originalContent: '',
      modifiedContent: '',
      collapsed: false,
      loading: true,
      dirty: false,
      diffResult: null,
      largeDiffRenderLimit: null
    }))
  )
  const [, setSectionHeights] = useState<Record<number, number>>({})
  const registry = useCombinedDiffSectionLoadRegistry(sections)
  const loader = useCombinedDiffSectionLoader({
    entrySet,
    file,
    generation: 0,
    registry,
    sectionCount: count,
    setSectionHeights,
    setSections
  })
  const retry = useCombinedDiffSectionRetry({
    invalidateViewStateCache: () => {},
    registry,
    setSectionHeights,
    setSections
  })
  useLayoutEffect(() => {
    registry.renderedIndicesRef.current = new Set(rendered)
  }, [registry.renderedIndicesRef, rendered])
  const { loadSection } = loader
  useEffect(() => {
    for (const index of rendered) {
      loadSection(index)
    }
  }, [loadSection, rendered])
  return { retry }
}

function captureReads() {
  const started: string[] = []
  const pending = new Map<string, () => void>()
  transport.diff.mockImplementation((_scope: unknown, request: { filePath: string }) => {
    started.push(request.filePath)
    return new Promise<GitDiffResult>((resolve) => {
      pending.set(request.filePath, () => {
        pending.delete(request.filePath)
        resolve({
          kind: 'text',
          originalContent: `before ${request.filePath}`,
          modifiedContent: `after ${request.filePath}`,
          originalIsBinary: false,
          modifiedIsBinary: false
        })
      })
    })
  })
  const settle = async (path: string): Promise<void> => {
    expect(pending.has(path)).toBe(true)
    await act(async () => pending.get(path)?.())
  }
  return { started, settle }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('drops an automatic reload that leaves the viewport while queued, then refreshes on return', async () => {
  vi.useFakeTimers()
  const reads = captureReads()
  const hook = renderHook(useReview, { initialProps: { count: 8, rendered: [6] } })
  await act(async () => {})
  await reads.settle('6.ts')
  expect(reads.started).toEqual(['6.ts', '0.ts'])
  act(() => hook.result.current.retry.requestSectionReload(6))
  await act(async () => vi.advanceTimersByTime(300))
  hook.rerender({ count: 8, rendered: [7] })
  await reads.settle('0.ts')
  await reads.settle('7.ts')
  for (let index = 1; index < 6; index += 1) {
    await reads.settle(`${index}.ts`)
  }
  expect(reads.started.filter((path) => path === '6.ts')).toHaveLength(1)
  hook.rerender({ count: 8, rendered: [6] })
  await act(async () => {})
  await reads.settle('6.ts')
  expect(reads.started.filter((path) => path === '6.ts')).toHaveLength(2)
})
