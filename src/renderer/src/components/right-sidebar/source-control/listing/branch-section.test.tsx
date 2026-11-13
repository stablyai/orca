// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { SourceControlTreeNode } from '../../../../../../shared/source-control/listing/source-control-tree'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { useSourceControlPanelViewState } from '../panel/use-panel-view-state'
import { SourceControlBranchSection } from './branch-section'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PR_HEAD = 'a1b2c3d4'
const entries: GitBranchChangeEntry[] = [
  { path: 'src/a.ts', status: 'modified' },
  { path: 'src/b.ts', status: 'added' }
]
const treeRows: SourceControlTreeNode<GitBranchChangeEntry, 'branch'>[] = [
  {
    type: 'directory',
    key: 'branch::src',
    name: 'src',
    path: 'src',
    area: 'branch',
    depth: 0,
    fileCount: 2,
    children: []
  }
]
const mergedReview: HostedReviewInfo = {
  provider: 'github',
  number: 412,
  title: 'Add retry',
  state: 'merged',
  url: '',
  status: 'success',
  updatedAt: '',
  mergeable: 'UNKNOWN',
  headSha: PR_HEAD
}

type SectionInputs = {
  worktreeId: string
  hostId?: ExecutionHostId
  instanceId?: string
  review?: HostedReviewInfo | null
  statusHeadOid?: string | null
  uncommittedCount?: number
  isMainWorktree?: boolean
  isBranchDiffEditorActive?: boolean
  tree?: boolean
}

function Panel({
  worktreeId,
  hostId,
  instanceId,
  review = mergedReview,
  statusHeadOid = PR_HEAD,
  uncommittedCount = 0,
  isMainWorktree = false,
  isBranchDiffEditorActive = false,
  tree = false
}: SectionInputs) {
  const owner = { id: worktreeId, hostId, instanceId }
  const view = useSourceControlPanelViewState({
    activeWorktreeId: worktreeId,
    activeWorktreeOwner: owner,
    settings: null,
    updateSettings: async () => {}
  })
  return (
    <SourceControlBranchSection
      activeOpenRowKeys={new Set()}
      branchSummary={{
        baseRef: 'origin/main',
        baseOid: 'base',
        compareRef: 'HEAD',
        headOid: statusHeadOid,
        mergeBase: 'base',
        changedFiles: entries.length,
        status: 'ready'
      }}
      filteredBranchEntries={entries}
      totalBranchEntryCount={entries.length}
      collapsedSections={view.collapsedSections}
      toggleSection={view.toggleSection}
      setBranchSectionAutoCollapsed={view.setBranchSectionAutoCollapsed}
      worktreeOwner={owner}
      review={review}
      statusHeadOid={statusHeadOid}
      uncommittedCount={uncommittedCount}
      isMainWorktree={isMainWorktree}
      isBranchDiffEditorActive={isBranchDiffEditorActive}
      sourceControlViewMode={tree ? 'tree' : 'list'}
      visibleBranchTreeRows={tree ? treeRows : []}
      fileListScrollElement={null}
      collapsedTreeDirs={new Set()}
      toggleTreeDir={() => {}}
      currentWorktreeId={worktreeId}
      worktreePath={`/work/${worktreeId}`}
      revealInExplorer={() => {}}
      activeConnectionId={null}
      openCommittedDiff={() => {}}
      openBranchAllDiffs={() => {}}
      diffCommentCountByPath={new Map()}
    />
  )
}

let container: HTMLDivElement
let root: Root
let worktreeCounter = 0

function nextWorktreeId(): string {
  worktreeCounter += 1
  return `branch-section-test-${worktreeCounter}`
}

async function render(inputs: SectionInputs): Promise<void> {
  await act(async () => root.render(<Panel {...inputs} />))
}

async function remount(inputs: SectionInputs): Promise<void> {
  await act(async () => root.unmount())
  root = createRoot(container)
  await render(inputs)
}

function toggle(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
  if (!button) {
    throw new Error('branch section toggle not rendered')
  }
  return button
}

function isExpanded(): boolean {
  return toggle().getAttribute('aria-expanded') === 'true'
}

function hasMergedChip(): boolean {
  return toggle().textContent?.includes('PR #412 is merged') ?? false
}

async function clickToggle(): Promise<void> {
  await act(async () => toggle().click())
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('names the merged review inside the toggle and collapses a safe-to-delete workspace', async () => {
  await render({ worktreeId: nextWorktreeId() })

  expect(toggle().textContent).toContain('Merged · PR #412 is merged')
  expect(toggle().getAttribute('aria-label')).toBeNull()
  expect(isExpanded()).toBe(false)
})

it('marks the main worktree merged without collapsing it', async () => {
  await render({ worktreeId: nextWorktreeId(), isMainWorktree: true })

  expect(hasMergedChip()).toBe(true)
  expect(isExpanded()).toBe(true)
})

it('keeps the chip but not the collapse while uncommitted changes remain', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId, uncommittedCount: 3 })

  expect(hasMergedChip()).toBe(true)
  expect(isExpanded()).toBe(true)
})

it('shows the chip only once HEAD is the merged review head', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId, statusHeadOid: 'feedbeef' })
  expect(hasMergedChip()).toBe(false)
  expect(isExpanded()).toBe(true)

  await render({ worktreeId })
  expect(hasMergedChip()).toBe(true)
})

it('waits for a known HEAD and keeps the last state through unknown reads', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId, statusHeadOid: null })
  expect(hasMergedChip()).toBe(false)
  expect(isExpanded()).toBe(true)

  await render({ worktreeId })
  expect(isExpanded()).toBe(false)

  await render({ worktreeId, statusHeadOid: null, review: null })
  expect(hasMergedChip()).toBe(true)
  expect(isExpanded()).toBe(false)

  await render({ worktreeId, review: null })
  expect(hasMergedChip()).toBe(true)
  expect(isExpanded()).toBe(false)
})

it('reopens an automatic collapse on a new commit but not on uncommitted changes', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId })
  await render({ worktreeId, uncommittedCount: 2 })
  expect(isExpanded()).toBe(false)

  await render({ worktreeId, statusHeadOid: 'feedbeef', uncommittedCount: 2 })
  expect(isExpanded()).toBe(true)
  expect(hasMergedChip()).toBe(false)

  await render({ worktreeId })
  expect(isExpanded()).toBe(true)
})

it('keeps a user expansion across re-entry, switching away and remounting', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId })
  await clickToggle()
  expect(isExpanded()).toBe(true)

  await render({ worktreeId, statusHeadOid: null })
  await render({ worktreeId })
  expect(isExpanded()).toBe(true)

  await render({ worktreeId: nextWorktreeId(), review: null })
  await render({ worktreeId })
  expect(isExpanded()).toBe(true)
  expect(hasMergedChip()).toBe(true)

  await remount({ worktreeId })
  expect(isExpanded()).toBe(true)
})

it('keeps an automatic collapse after a remount', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId })
  await remount({ worktreeId })

  expect(isExpanded()).toBe(false)
  expect(hasMergedChip()).toBe(true)
})

it('never collapses a user-toggled section', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId, review: { ...mergedReview, state: 'open' } })
  await clickToggle()
  await clickToggle()

  await render({ worktreeId })
  expect(hasMergedChip()).toBe(true)
  expect(isExpanded()).toBe(true)
})

it('skips the collapse for the session when a branch diff is active as the workspace turns safe', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId, isBranchDiffEditorActive: true })
  expect(isExpanded()).toBe(true)

  await render({ worktreeId })
  expect(isExpanded()).toBe(true)
  expect(hasMergedChip()).toBe(true)
})

it('reopens an automatic collapse when the review is no longer merged', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId })
  expect(isExpanded()).toBe(false)

  await render({ worktreeId, review: { ...mergedReview, state: 'open' } })
  expect(isExpanded()).toBe(true)
  expect(hasMergedChip()).toBe(false)
})

it.each(['open', 'closed'] as const)(
  'lets a known %s review reopen the collapse and clear the chip while HEAD is unknown',
  async (state) => {
    const worktreeId = nextWorktreeId()
    await render({ worktreeId })
    expect(isExpanded()).toBe(false)

    await render({ worktreeId, statusHeadOid: null, review: { ...mergedReview, state } })
    expect(isExpanded()).toBe(true)
    expect(hasMergedChip()).toBe(false)
  }
)

it('keeps disclosure and merged proof apart for same-ID workspaces on other hosts', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId, hostId: 'ssh:host-a' })
  await clickToggle()
  expect(isExpanded()).toBe(true)

  await render({ worktreeId, hostId: 'ssh:host-b', review: null })
  expect(hasMergedChip()).toBe(false)
  await render({ worktreeId, hostId: 'ssh:host-b' })
  expect(isExpanded()).toBe(false)

  await render({ worktreeId, hostId: 'ssh:host-a', review: null })
  expect(isExpanded()).toBe(true)
  expect(hasMergedChip()).toBe(true)
})

it('starts a recreated workspace fresh and leaves the old checkout restorable', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId, instanceId: 'first' })
  expect(isExpanded()).toBe(false)

  await render({ worktreeId, instanceId: 'second', review: null })
  expect(isExpanded()).toBe(true)
  expect(hasMergedChip()).toBe(false)

  await render({ worktreeId, instanceId: 'first', review: null })
  expect(isExpanded()).toBe(false)
  expect(hasMergedChip()).toBe(true)
})

it('moves focus from a row to the header when collapsing', async () => {
  const worktreeId = nextWorktreeId()
  await render({ worktreeId, statusHeadOid: null, tree: true })
  const directoryRow = container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')[1]
  directoryRow.focus()
  expect(document.activeElement).toBe(directoryRow)

  await render({ worktreeId, tree: true })
  expect(isExpanded()).toBe(false)
  expect(document.activeElement).toBe(toggle())
})

it('remembers collapse ownership after other workspaces evict the disclosure cache', async () => {
  const userExpanded = nextWorktreeId()
  const autoCollapsed = nextWorktreeId()
  const others = Array.from({ length: 512 }, () => nextWorktreeId())
  const { worktreesByRepo: previousWorktreesByRepo, repos: previousRepos } = useAppStore.getState()
  useAppStore.setState({
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [userExpanded, autoCollapsed, ...others].map((id) => makeWorktree(id, id))
    }
  })
  try {
    await render({ worktreeId: userExpanded })
    await clickToggle()
    await render({ worktreeId: autoCollapsed })
    for (const worktreeId of others) {
      await render({ worktreeId, review: null })
      await clickToggle()
    }

    await render({ worktreeId: userExpanded })
    expect(isExpanded()).toBe(true)
    await render({ worktreeId: autoCollapsed })
    expect(isExpanded()).toBe(false)
  } finally {
    useAppStore.setState({ worktreesByRepo: previousWorktreesByRepo, repos: previousRepos })
  }
})
