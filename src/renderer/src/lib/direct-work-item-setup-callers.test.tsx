// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { hostMocks, mocks } from './launch-work-item-direct-test-fixture'
import { useAppStore } from '@/store'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import type { DirectWorkItemSetupRequest } from './direct-work-item-setup'
import type { GitHubProjectTable } from '../../../shared/github/project-types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { startFixChecksFromDialog } from '@/components/pull-request-page/checks/fix-launch'
import { fixBrokenGitHubChecks } from '@/components/github-item-dialog/inspect-pull-request/checks-tab-actions'
import ProjectViewWrapper from '@/components/github-project/ProjectViewWrapper'

const links = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/lib/app-http-link-open', () => ({ openAppHttpLink: links.open }))
vi.mock('@/lib/repo-slug-index', () => ({
  useRepoSlugIndex: () => ({
    ready: true,
    lookupSlug: () => mocks.store.repos,
    lookupSlugMatches: () => ({ origin: mocks.store.repos, upstream: [] })
  })
}))
vi.mock('@/components/github-project/useProjectRowMutations', () => ({
  useProjectRowMutations: () => ({})
}))
vi.mock('@/components/github-project/useProjectViewTable', () => ({
  useProjectViewTable: () => ({
    activeProject: table.project,
    table,
    visibleTable: table,
    currentCacheKey: 'local:project-1',
    sourceTarget: { kind: 'ipc' },
    views: []
  })
}))
vi.mock('@/components/github-project/ProjectViewToolbar', () => ({
  ProjectViewToolbar: () => null
}))
vi.mock('@/components/github-project/ProjectViewStates', () => ({
  ProjectViewTabStrip: () => null
}))
vi.mock('@/components/github-project/ProjectItemSlugDialog', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectMissingRepoDialog', () => ({
  ProjectMissingRepoDialog: () => null
}))
vi.mock('@/components/github-project/ProjectBoard', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectRoadmap', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectViewList', () => ({
  default: (p: {
    onStartWork: (row: GitHubProjectTable['rows'][number]) => void
    onOpenDialog: (row: GitHubProjectTable['rows'][number]) => void
  }) => (
    <>
      <button onClick={() => p.onStartWork(table.rows[0])}>Start work</button>
      <button onClick={() => p.onOpenDialog(table.rows[0])}>Open item</button>
    </>
  )
}))
vi.mock('@/components/GitHubItemDialog', () => ({
  default: (p: { onUse: (item: GitHubWorkItem) => void; workItem: GitHubWorkItem }) => (
    <button onClick={() => p.onUse(p.workItem)}>Use item</button>
  )
}))

const item: GitHubWorkItem = {
  id: 'pr-42',
  state: 'open',
  labels: [],
  updatedAt: '',
  author: null,
  repoId: 'repo-1',
  type: 'pr',
  number: 42,
  title: 'Fix checks',
  url: 'https://github.com/acme/repo/pull/42'
}
const table: GitHubProjectTable = {
  project: {
    id: 'project-1',
    host: 'github.com',
    owner: 'acme',
    ownerType: 'organization',
    number: 1,
    title: 'Board',
    url: 'https://github.com/orgs/acme/projects/1'
  },
  selectedView: {
    id: 'view-1',
    number: 1,
    name: 'All',
    layout: 'TABLE_LAYOUT',
    filter: '',
    fields: [],
    groupByFields: [],
    sortByFields: []
  },
  rows: [
    {
      id: 'item-1',
      itemType: 'PULL_REQUEST',
      content: {
        number: 42,
        title: item.title,
        url: item.url,
        body: null,
        state: 'OPEN',
        stateReason: null,
        isDraft: false,
        repository: 'acme/repo',
        assignees: [],
        labels: [],
        parentIssue: null,
        issueType: null
      },
      fieldValuesByFieldId: {},
      updatedAt: '',
      position: 0
    }
  ],
  totalCount: 1,
  parentFieldDropped: false
}
let unsubscribe: () => void
beforeEach(() => {
  const ui = createUIStore()
  useAppStore.setState({
    openModal: ui.getState().openModal,
    closeModal: ui.getState().closeModal,
    modalData: {},
    allWorktrees: () => [],
    repos: [
      {
        ...useAppStore.getState().repos[0],
        hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' }, setupRunPolicy: 'ask' }
      }
    ]
  })
  unsubscribe = ui.subscribe(({ activeModal, modalData }) =>
    useAppStore.setState({ activeModal, modalData })
  )
  hostMocks.checkRuntimeHooks.mockResolvedValue({
    hasHooks: true,
    hooks: { scripts: { setup: 'echo setup' } },
    mayNeedUpdate: false
  })
  links.open.mockClear()
})
afterEach(() => {
  cleanup()
  useAppStore.getState().closeModal()
  unsubscribe()
})
async function pending(): Promise<DirectWorkItemSetupRequest> {
  await vi.waitFor(() => expect(useAppStore.getState().activeModal).toBe('new-workspace-composer'))
  expect(mocks.createWorktree).not.toHaveBeenCalled()
  expect(mocks.toastError).not.toHaveBeenCalled()
  expect(links.open).not.toHaveBeenCalled()
  // SAFETY: the real direct-launch boundary installed the request before these assertions.
  return useAppStore.getState().modalData.directSetup as DirectWorkItemSetupRequest
}

it('retains an edited Fix checks request through the PR-page Start handoff', async () => {
  const launch = startFixChecksFromDialog({
    targetRepoId: 'repo-1',
    item,
    agent: 'codex',
    agentArgs: '--model o3',
    commandInput: 'My edited prompt',
    sessionOptions: { effort: 'high' }
  })
  ;(await pending()).choose('run')
  await expect(launch).resolves.toBe(true)
  expect(mocks.resolvePrBase).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 42 }))
  expect(mocks.createWorktree).toHaveBeenCalledOnce()
  expect(mocks.createWorktree.mock.calls[0][3]).toBe('run')
  expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'My edited prompt', agent: 'codex', submit: true })
  )
})

it('lets the GitHub item checks action answer Ask without its toast fallback', async () => {
  const launch = fixBrokenGitHubChecks({
    item,
    repoId: 'repo-1',
    fixingChecks: false,
    failedChecksLength: 1,
    list: [],
    setFixingChecks: vi.fn()
  })
  ;(await pending()).choose('skip')
  await launch
  expect(mocks.createWorktree).toHaveBeenCalledOnce()
  expect(mocks.createWorktree.mock.calls[0][3]).toBe('skip')
  expect(mocks.toastError).not.toHaveBeenCalled()
})

it.each(['Start work', 'Use item'])(
  'keeps the project %s action in Orca when setup asks',
  async (entry) => {
    render(<ProjectViewWrapper selectedRepoIds={new Set(['repo-1'])} sourceHostId="local" />)
    if (entry === 'Use item') {
      fireEvent.click(screen.getByRole('button', { name: 'Open item' }))
    }
    fireEvent.click(screen.getByRole('button', { name: entry }))
    const request = await pending()
    await act(async () => request.cancel())
    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(mocks.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
    expect(links.open).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  }
)
