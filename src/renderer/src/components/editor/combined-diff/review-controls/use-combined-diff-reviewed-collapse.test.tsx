// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { diffReviewKey, getReviewedDiffs, setDiffReviewed } from '@/lib/editor/diff-reviewed-files'
import type * as RuntimeFileMetadata from '@/runtime/files/metadata/runtime-file-metadata-client'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { useCombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'
import { useCombinedDiffViewRestore } from '../remember-view/use-combined-diff-view-restore'
import { useCombinedDiffViewPersist } from '../remember-view/use-combined-diff-view-persist'
import { clearCombinedDiffViewMemory } from '../remember-view/combined-diff-view-cache'
import { combinedDiffViewPreferences } from '../remember-view/combined-diff-view-memory'
import { useCombinedDiffReviewedCollapse } from './use-combined-diff-reviewed-collapse'

const { stat } = vi.hoisted(() => ({ stat: vi.fn() }))
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileMetadata>()),
  statRuntimePath: stat
}))
const file: OpenFile = {
  id: 'all',
  worktreeId: 'wt',
  filePath: '/repo',
  relativePath: 'Changes',
  mode: 'diff',
  diffSource: 'combined-all',
  runtimeEnvironmentId: null,
  language: 'plaintext',
  isDirty: false,
  branchCompare: {
    baseRef: 'main',
    baseOid: 'base',
    compareRef: 'HEAD',
    headOid: 'head',
    mergeBase: 'merge-base',
    compareVersion: 'version'
  }
}
const status = [
  { path: 'a.ts', status: 'modified', area: 'unstaged', added: 1, removed: 1 },
  { path: 'a.ts', status: 'modified', area: 'staged', added: 1, removed: 1 },
  { path: 'c.ts', status: 'modified', area: 'unstaged', added: 1, removed: 1 }
] satisfies Parameters<typeof useCombinedDiffEntrySet>[0]['gitStatusEntries']
const branch = [{ path: 'b.ts', status: 'modified', added: 1, removed: 1 }] satisfies Parameters<
  typeof useCombinedDiffEntrySet
>[0]['liveBranchEntries']

function useViewAll() {
  const [sections, setSections] = useState<DiffSection[]>([])
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [, setGeneration] = useState(0)
  const registry = useCombinedDiffSectionLoadRegistry(sections)
  const entrySet = useCombinedDiffEntrySet({
    file,
    gitStatusEntries: status,
    liveBranchEntries: branch,
    sectionsRef: registry.sectionsRef
  })
  const restore = useCombinedDiffViewRestore({
    file,
    entrySet,
    gitStatusEntries: status,
    registry,
    setSections,
    setGeneration,
    setSectionHeights,
    viewStateKey: 'view-all'
  })
  const viewedSectionKeys = useCombinedDiffReviewedCollapse({
    file,
    entrySet,
    setSections,
    viewStateKey: 'view-all'
  })
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  useCombinedDiffViewPersist({
    combinedGitStatusSignature: '',
    entryCount: entrySet.entries.length,
    entrySignature: entrySet.entrySignature,
    memoryLeaseRef: restore.memoryLeaseRef,
    loadedIndicesRef: registry.loadedIndicesRef,
    scrollContainerRef,
    sectionHeights,
    sections,
    viewStateKey: 'view-all'
  })
  return { sections, setSections, viewedSectionKeys }
}

function mark(path: string, scope: string): void {
  const owner = getEditorFileReadContext(useAppStore.getState(), file, '/repo')
  setDiffReviewed(diffReviewKey(owner, path, scope), {
    viewedAt: 1800000000000,
    modifiedTime: 123,
    contentSignature: 'reviewed bytes',
    entrySignature: '["modified",null,1,1]'
  })
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1800000000000)
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: 'wt',
    activeFileId: file.id,
    openFiles: [file],
    repos: [
      { id: 'repo', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
    ],
    worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', path: '/repo' })] }
  })
  for (const key of getReviewedDiffs().keys()) {
    setDiffReviewed(key, null)
  }
  stat.mockReset().mockResolvedValue({ mtime: 123, size: 5, isDirectory: false })
  combinedDiffViewPreferences.collapsed = null
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  clearCombinedDiffViewMemory()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('collapses only matching Viewed comparisons and lets reviewed files be expanded manually', async () => {
  mark('a.ts', 'unstaged')
  mark('b.ts', '["branch","merge-base","head"]')
  const view = renderHook(useViewAll)
  await act(async () => {})
  expect([...view.result.current.viewedSectionKeys]).toEqual([
    'unstaged:a.ts',
    'combined-branch:b.ts'
  ])
  expect(view.result.current.sections.map((s) => [s.key, s.collapsed])).toEqual([
    ['unstaged:a.ts', true],
    ['staged:a.ts', false],
    ['unstaged:c.ts', false],
    ['combined-branch:b.ts', true]
  ])
  act(() =>
    view.result.current.setSections((sections) =>
      sections.map((section) => ({ ...section, collapsed: false }))
    )
  )
  act(() => mark('a.ts', 'staged'))
  await act(async () => {})
  expect(view.result.current.sections.map((s) => s.collapsed)).toEqual([false, true, false, false])
  view.unmount()
  const reopened = renderHook(useViewAll)
  await act(async () => {})
  expect(reopened.result.current.sections.map((s) => s.collapsed)).toEqual([
    true,
    true,
    false,
    true
  ])
})

it('leaves changed files and a different branch comparison expanded', async () => {
  mark('a.ts', 'unstaged')
  mark('b.ts', '["branch","old-base","old-head"]')
  stat.mockResolvedValue({ mtime: 124, size: 5, isDirectory: false })
  const view = renderHook(useViewAll)
  await act(async () => {})
  expect(view.result.current.sections.map((s) => s.collapsed)).toEqual([false, false, false, false])
})

it('does not collapse a dirty draft when a Viewed mark arrives', async () => {
  const view = renderHook(useViewAll)
  act(() =>
    view.result.current.setSections((sections) =>
      sections.map((section) =>
        section.path === 'a.ts' ? { ...section, dirty: true, modifiedContent: 'draft' } : section
      )
    )
  )
  act(() => mark('a.ts', 'unstaged'))
  await act(async () => {})
  expect(view.result.current.sections[0]).toMatchObject({
    collapsed: false,
    modifiedContent: 'draft'
  })
})

it('does not count loading or collapsing files as explicit review progress', async () => {
  const view = renderHook(useViewAll)
  act(() =>
    view.result.current.setSections((sections) =>
      sections.map((section) => ({
        ...section,
        loading: false,
        loadOnDemand: false,
        collapsed: true
      }))
    )
  )
  await act(async () => {})
  expect([...view.result.current.viewedSectionKeys]).toEqual([])
})
