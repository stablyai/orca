// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { TaskPageGitHubRows } from './Rows'

type CellProps = { repo: Repo | null; sourceContext: TaskSourceContext | null }
const cellProps = vi.hoisted(() => new Map<string, CellProps>())
vi.mock('./ReviewCell', () => ({
  PRReviewCell: (props: CellProps) => (cellProps.set('review', props), null)
}))
vi.mock('./MergeCell', () => ({
  PRMergeCell: (props: CellProps) => (cellProps.set('merge', props), null)
}))
vi.mock('./StatusCell', () => ({
  GHStatusCell: (props: CellProps) => (cellProps.set('status', props), null)
}))
vi.mock('./AssigneesCell', () => ({
  GHAssigneesCell: (props: CellProps) => (cellProps.set('assignees', props), null)
}))
vi.mock('./ChecksCell', () => ({ PRChecksCell: () => null }))

const sshRow: Repo = {
  id: 'twin',
  path: '/remote/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1,
  connectionId: 'builder'
}
const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 2,
  executionHostId: 'local'
}
const pr: GitHubWorkItem = {
  id: 'pr-7',
  type: 'pr',
  number: 7,
  title: 'Fix it',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  author: 'octo',
  repoId: 'twin',
  repoHostId: 'ssh:builder'
}

function renderRows(item: GitHubWorkItem, showPRManagementColumns: boolean) {
  const repos = [sshRow, localRow]
  const model = {
    repos,
    // By id a map keeps the last twin, which is the row that did not return the item.
    repoMap: new Map(repos.map((repo) => [repo.id, repo])),
    allWorktrees: [],
    selectedRepos: repos,
    openGitHubDetailPage: vi.fn(),
    githubWorkItemMutation: vi.fn(),
    filteredWorkItems: [item],
    showGitHubTaskSkeletons: false,
    showPRManagementColumns,
    githubTaskGridClass: '',
    ensurePRChecksLoaded: vi.fn(),
    handleUseWorkItem: vi.fn(),
    handleOpenOrUseGitHubWorkItem: vi.fn()
  }
  render(
    <TooltipProvider>
      {/* oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only the fields above. */}
      <TaskPageGitHubRows model={model as unknown as TaskPageComposerActionsModel} />
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
  cellProps.clear()
})

describe('GitHub task rows on a repo id two hosts share', () => {
  it.each(['review', 'merge'])('%s runs on the host that returned the PR', (cell) => {
    renderRows(pr, true)

    expect(cellProps.get(cell)?.repo).toBe(sshRow)
    expect(cellProps.get(cell)?.sourceContext?.hostId).toBe('ssh:builder')
  })

  it.each(['status', 'assignees'])('%s edits run on the host that returned the item', (cell) => {
    renderRows({ ...pr, type: 'issue', id: 'issue-7' }, false)

    expect(cellProps.get(cell)?.repo).toBe(sshRow)
    expect(cellProps.get(cell)?.sourceContext?.hostId).toBe('ssh:builder')
  })
})
