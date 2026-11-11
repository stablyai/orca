import { acquireCombinedDiffSectionOperation } from '../load-sections/combined-diff-section-connection'
// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { GitDiffTextResult } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import type * as RuntimeFileMetadata from '@/runtime/files/metadata/runtime-file-metadata-client'
import { getReviewedDiffs, setDiffReviewed } from '@/lib/editor/diff-reviewed-files'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DiffViewedControl } from '../../diff/review/diff-viewed-control'
import { DiffSectionHeader } from '../../diff/sections/DiffSectionHeader'
import { useCombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffReviewedCollapse } from './use-combined-diff-reviewed-collapse'
import type { fetchCombinedDiffSection } from '../load-sections/fetch-combined-diff-section'
import { CombinedDiffViewedControl } from './combined-diff-viewed-control'

const { stat } = vi.hoisted(() => ({ stat: vi.fn() }))
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileMetadata>()),
  statRuntimePath: stat
}))
const single: OpenFile = {
  id: 'single',
  worktreeId: 'wt',
  filePath: '/repo/a.ts',
  relativePath: 'a.ts',
  mode: 'diff',
  diffSource: 'unstaged',
  runtimeEnvironmentId: null,
  language: 'typescript',
  isDirty: false
}
const combined: OpenFile = {
  ...single,
  id: 'combined',
  filePath: '/repo',
  relativePath: 'Changes',
  diffSource: 'combined-uncommitted'
}
const result: GitDiffTextResult = {
  kind: 'text',
  originalContent: 'before',
  modifiedContent: 'after',
  originalIsBinary: false,
  modifiedIsBinary: false
}
const entries = [
  { path: 'a.ts', area: 'unstaged', status: 'modified', added: 1, removed: 1 }
] satisfies Parameters<typeof useCombinedDiffEntrySet>[0]['gitStatusEntries']
const branchEntries = []

function Review({
  unloaded = false,
  loadForReview
}: {
  unloaded?: boolean
  loadForReview?: () => ReturnType<typeof fetchCombinedDiffSection>
} = {}) {
  const [sections, setSections] = useState<DiffSection[]>([
    {
      key: 'unstaged:a.ts',
      path: 'a.ts',
      status: 'modified',
      area: 'unstaged',
      added: 1,
      removed: 1,
      originalContent: 'before',
      modifiedContent: 'after',
      collapsed: unloaded,
      loading: unloaded,
      dirty: false,
      diffResult: unloaded ? null : result,
      reviewModifiedTime: unloaded ? undefined : 123,
      largeDiffRenderLimit: null
    }
  ])
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections
  const entrySet = useCombinedDiffEntrySet({
    file: combined,
    gitStatusEntries: entries,
    liveBranchEntries: branchEntries,
    sectionsRef
  })
  useCombinedDiffReviewedCollapse({
    file: combined,
    entrySet,
    setSections,
    viewStateKey: 'controls'
  })
  const section = sections[0]!
  return (
    <TooltipProvider>
      <DiffSectionHeader
        path="a.ts"
        dirty={section.dirty}
        collapsed={section.collapsed}
        added={1}
        removed={1}
        onToggle={() =>
          setSections(([current]) => [{ ...current!, collapsed: !current!.collapsed }])
        }
        onOpenSection={() => {}}
        openSectionTitle="Open diff"
        trailingContent={
          <CombinedDiffViewedControl
            file={combined}
            section={section}
            setSections={setSections}
            loadForReview={loadForReview}
          />
        }
      />
      <DiffViewedControl file={single} content={{ ...result, reviewModifiedTime: 123 }} />
      <button
        onClick={() =>
          setSections(([current]) => [{ ...current!, dirty: true, modifiedContent: 'draft' }])
        }
      >
        Edit draft
      </button>
      <button
        onClick={() =>
          setSections(([current]) => [
            {
              ...current!,
              diffResult: { ...result, modifiedContent: 'changed' },
              modifiedContent: 'changed'
            }
          ])
        }
      >
        Reload changed diff
      </button>
      {!section.collapsed && <pre aria-label="Diff contents">{section.modifiedContent}</pre>}
    </TooltipProvider>
  )
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: 'wt',
    activeFileId: single.id,
    openFiles: [single, combined],
    repos: [
      { id: 'repo', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
    ],
    worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', path: '/repo' })] },
    gitStatusByWorktree: { wt: entries }
  })
  for (const key of getReviewedDiffs().keys()) {
    setDiffReviewed(key, null)
  }
  vi.spyOn(toast, 'error').mockImplementation(() => '')
  stat.mockReset().mockResolvedValue({ mtime: 123, size: 5, isDirectory: false })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('syncs Viewed in both directions while header collapse stays independent', async () => {
  render(<Review />)
  const header = screen.getByText('a.ts').closest('[data-combined-diff-section-header]')!
  fireEvent.click(header)
  expect(
    screen.getAllByRole('checkbox', { name: 'Viewed' }).map((c) => c.getAttribute('aria-checked'))
  ).toEqual(['false', 'false'])
  fireEvent.click(header)
  await act(async () => fireEvent.click(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!))
  expect(
    screen.getAllByRole('checkbox', { name: 'Viewed' }).map((c) => c.getAttribute('aria-checked'))
  ).toEqual(['true', 'true'])
  expect(screen.queryByLabelText('Diff contents')).toBeNull()
  await act(async () => fireEvent.click(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!))
  expect(
    screen.getAllByRole('checkbox', { name: 'Viewed' }).map((c) => c.getAttribute('aria-checked'))
  ).toEqual(['false', 'false'])
  expect(screen.getByLabelText('Diff contents').textContent).toBe('after')
  await act(async () => fireEvent.click(screen.getAllByRole('checkbox', { name: 'Viewed' })[1]!))
  expect(
    screen.getAllByRole('checkbox', { name: 'Viewed' }).map((c) => c.getAttribute('aria-checked'))
  ).toEqual(['true', 'true'])
  expect(screen.queryByLabelText('Diff contents')).toBeNull()
})

it('clears both Viewed controls when loaded bytes change despite an unchanged modification time', async () => {
  render(<Review />)
  await act(async () => fireEvent.click(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!))
  expect(
    screen.getAllByRole('checkbox', { name: 'Viewed' }).map((c) => c.getAttribute('aria-checked'))
  ).toEqual(['true', 'true'])
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Reload changed diff' }))
  )
  expect(
    screen.getAllByRole('checkbox', { name: 'Viewed' }).map((c) => c.getAttribute('aria-checked'))
  ).toEqual(['false', 'false'])
})

it('rejects marking if a draft is edited while file verification is pending', async () => {
  let finish!: (value: { mtime: number }) => void
  stat.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(<Review />)
  fireEvent.click(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!)
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))
  await act(async () => finish({ mtime: 123 }))
  expect(
    screen.getAllByRole('checkbox', { name: 'Viewed' }).map((c) => c.getAttribute('aria-checked'))
  ).toEqual(['false', 'false'])
  expect(screen.getByLabelText('Diff contents').textContent).toBe('draft')
})

it.each(['branch', 'commit'] as const)(
  'shares review marks for an opened historical %s comparison',
  async (source) => {
    const entry = { path: 'a.ts', status: 'modified', added: 1, removed: 1 } as const
    if (source === 'branch') {
      useAppStore.getState().openBranchDiff(
        'wt',
        '/repo',
        entry,
        {
          baseRef: 'main',
          baseOid: 'base',
          compareRef: 'HEAD',
          headOid: 'head',
          mergeBase: 'merge-base'
        },
        'typescript'
      )
    } else {
      useAppStore.getState().openCommitDiff(
        'wt',
        '/repo',
        entry,
        {
          commitOid: 'review-commit',
          parentOid: 'review-parent',
          compareRef: 'review-commit',
          baseRef: 'review-parent'
        },
        'typescript'
      )
    }
    const historical = useAppStore.getState().openFiles.find((file) => file.diffSource === source)!
    const individual = render(
      <TooltipProvider>
        <DiffViewedControl
          file={historical}
          content={{ ...result, reviewModifiedTime: source === 'commit' ? null : 123 }}
        />
      </TooltipProvider>
    )
    await act(async () => fireEvent.click(screen.getByRole('checkbox', { name: 'Viewed' })))
    expect(screen.getByRole('checkbox', { name: 'Viewed' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    individual.unmount()
    render(
      <CombinedDiffViewedControl
        file={{
          ...combined,
          diffSource: source === 'branch' ? 'combined-branch' : 'combined-commit',
          branchCompare: historical.branchCompare,
          commitCompare: historical.commitCompare
        }}
        section={{
          key: 'history:a.ts',
          ...entry,
          originalContent: 'before',
          modifiedContent: 'after',
          collapsed: false,
          loading: false,
          dirty: false,
          diffResult: result,
          reviewModifiedTime: source === 'commit' ? null : 123,
          largeDiffRenderLimit: null
        }}
        setSections={() => {}}
      />
    )
    expect(screen.getByRole('checkbox', { name: 'Viewed' }).getAttribute('aria-checked')).toBe(
      'true'
    )
  }
)

it('keeps a new review mark when another surface still holds older cached bytes', async () => {
  render(<Review />)
  fireEvent.click(screen.getByRole('button', { name: 'Reload changed diff' }))
  await act(async () => fireEvent.click(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!))
  expect(
    screen.getAllByRole('checkbox', { name: 'Viewed' }).map((c) => c.getAttribute('aria-checked'))
  ).toEqual(['true', 'false'])
})

it.each([123, 124])(
  'verifies an unloaded collapsed file before marking it (mtime %s)',
  async (mtime) => {
    let finish!: (value: Awaited<ReturnType<typeof fetchCombinedDiffSection>>) => void
    const loadForReview = () =>
      new Promise<Awaited<ReturnType<typeof fetchCombinedDiffSection>>>((resolve) => {
        finish = resolve
      })
    render(<Review unloaded loadForReview={loadForReview} />)
    const checkbox = screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!
    expect(checkbox.hasAttribute('disabled')).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.hasAttribute('disabled')).toBe(true)
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    stat.mockResolvedValue({ mtime })
    await act(async () =>
      finish({
        result,
        reviewModifiedTime: Promise.resolve(123),
        operation: acquireCombinedDiffSectionOperation(combined, 'a.ts')
      })
    )
    expect(checkbox.getAttribute('aria-checked')).toBe(mtime === 123 ? 'true' : 'false')
    expect(toast.error).toHaveBeenCalledTimes(mtime === 123 ? 0 : 1)
    expect(screen.queryByLabelText('Diff contents')).toBeNull()
    expect(checkbox.hasAttribute('disabled')).toBe(false)
  }
)

it('leaves a collapsed file unviewed when loading fails', async () => {
  render(
    <Review
      unloaded
      loadForReview={async () => {
        throw new Error('offline')
      }}
    />
  )
  await act(async () => fireEvent.click(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!))
  expect(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!.getAttribute('aria-checked')).toBe(
    'false'
  )
  expect(screen.queryByLabelText('Diff contents')).toBeNull()
})

it('rejects an unloaded review invalidated during the final file verification', async () => {
  let finish!: (value: { mtime: number }) => void
  const assertCurrent = vi.fn()
  const loadForReview = async () => ({
    result,
    reviewModifiedTime: Promise.resolve(123),
    operation: {
      ...acquireCombinedDiffSectionOperation(combined, 'a.ts'),
      assertCurrent
    }
  })
  render(<Review unloaded loadForReview={loadForReview} />)
  stat.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await act(async () => fireEvent.click(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!))
  assertCurrent.mockImplementation(() => {
    throw new Error('invalidated')
  })
  await act(async () => finish({ mtime: 123 }))
  expect(screen.getAllByRole('checkbox', { name: 'Viewed' })[0]!.getAttribute('aria-checked')).toBe(
    'false'
  )
  expect(screen.queryByLabelText('Diff contents')).toBeNull()
})
