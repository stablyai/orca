// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type {
  GitStatusEntry,
  GitStatusResult
} from '../../../../../../shared/git/status/git-status-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { useWorkspaceCopyStatus, type WorkspaceCopyStatus } from './use-workspace-copy-status'
import { recordWorktreeBranchSwitchLanded } from './workspace-branch-switch-status'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import { refreshGitStatusForWorktree } from '../sync/git-status-refresh'

// The same project at the same path on this machine and on an SSH host share one status slot.
const id = 'repo1::/srv/ai-tools'
const path = '/srv/ai-tools'
const initialAppState = useAppStore.getInitialState()
const dirty: GitStatusEntry[] = [{ path: 'b.txt', status: 'modified', area: 'unstaged' }]
const clean: GitStatusResult = {
  entries: [],
  head: 'aaa',
  branch: 'refs/heads/master',
  upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
  conflictOperation: 'unknown'
}

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo1',
    path,
    displayName: 'ai-tools',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}
function copy(overrides: Partial<Worktree>): Worktree {
  return {
    id,
    repoId: 'repo1',
    path,
    head: 'aaa',
    branch: 'refs/heads/master',
    isBare: false,
    isMainWorktree: true,
    displayName: 'master',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const status = vi.fn<(args: { connectionId?: string }) => Promise<GitStatusResult>>()
const container = document.createElement('div')
let root = createRoot(container)
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

beforeEach(() => {
  status.mockResolvedValue(clean)
  vi.stubGlobal('window', { ...window, api: { git: { status } } })
  useAppStore.setState({
    repos: [repo({ connectionId: null }), repo({ connectionId: 'box-b' })],
    worktreesByRepo: {
      repo1: [
        copy({ hostId: 'local' }),
        copy({ hostId: 'ssh:box-b', head: 'bbb', branch: 'refs/heads/feature' })
      ]
    },
    // The SSH copy is selected and dirty.
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'ssh:box-b',
    gitStatusByWorktree: { [id]: [...dirty] },
    gitStatusHeadByWorktree: { [id]: 'bbb' }
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  useAppStore.setState(initialAppState, true)
  vi.unstubAllGlobals()
})

async function readFor(hostId: ExecutionHostId): Promise<{ current: WorkspaceCopyStatus | null }> {
  const seen: { current: WorkspaceCopyStatus | null } = { current: null }
  function Probe() {
    seen.current = useWorkspaceCopyStatus({
      worktreeId: id,
      worktreePath: path,
      hostId,
      open: true,
      refreshOnOpen: true
    })
    return null
  }
  await act(async () => root.render(<Probe />))
  return seen
}

function deferStatus(): (result: GitStatusResult) => Promise<void> {
  let finish: (result: GitStatusResult) => void = () => {}
  status.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  return async (result) => {
    await act(async () => finish(result))
  }
}

it("reads a twin's own status instead of the selected copy's slot", async () => {
  const seen = await readFor('local')
  expect(seen.current).toMatchObject({ statusKnown: true, entries: [] })
  expect(useAppStore.getState().gitStatusByWorktree[id]).toEqual(dirty)
  expect(useAppStore.getState().gitStatusHeadByWorktree[id]).toBe('bbb')
})

it('keeps a hostless local selection from claiming the slot for either copy', async () => {
  useAppStore.setState({ activeWorkspaceExecutionHostId: null })
  const seen = await readFor('ssh:box-b')
  expect(seen.current).toMatchObject({ statusKnown: true, entries: [] })
  expect(status).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'box-b' }))
  expect(useAppStore.getState().gitStatusByWorktree[id]).toEqual(dirty)
})

it('drops an open-time refresh that lands after the user selects the twin', async () => {
  useAppStore.setState({
    activeWorkspaceExecutionHostId: 'local',
    gitStatusByWorktree: { [id]: [] }
  })
  const finish = deferStatus()
  await readFor('local')
  await act(async () =>
    useAppStore.setState({
      activeWorkspaceExecutionHostId: 'ssh:box-b',
      gitStatusByWorktree: { [id]: [...dirty] }
    })
  )
  await finish(clean)
  expect(useAppStore.getState().gitStatusByWorktree[id]).toEqual(dirty)
  expect(useAppStore.getState().gitStatusHeadByWorktree[id]).toBe('bbb')
})

it('drops a landed-switch refresh that settles after the user selects the twin', async () => {
  useAppStore.setState({
    activeWorkspaceExecutionHostId: 'local',
    gitStatusByWorktree: { [id]: [] }
  })
  const finish = deferStatus()
  recordWorktreeBranchSwitchLanded(id, 'local', path)
  useAppStore.setState({
    activeWorkspaceExecutionHostId: 'ssh:box-b',
    gitStatusByWorktree: { [id]: [...dirty] }
  })
  await finish(clean)
  expect(useAppStore.getState().gitStatusByWorktree[id]).toEqual(dirty)
})

it("doesn't trust the twin's slot when this copy becomes the owner", async () => {
  const seen = await readFor('local')
  expect(seen.current).toMatchObject({ statusKnown: true, entries: [] })
  const finish = deferStatus()
  await act(async () => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  // The slot still holds the SSH copy's dirty status until this copy's refresh lands.
  expect(seen.current?.entries).toEqual([])
  await finish(clean)
  expect(useAppStore.getState().gitStatusByWorktree[id]).toEqual([])
  expect(seen.current).toMatchObject({ statusKnown: true, entries: [] })
})

it("shows the copy's own status when an identical newer poll supersedes the picker refresh", async () => {
  // Both copies clean at the same commit; the store keeps the same entries reference for an identical status.
  useAppStore.setState({
    gitStatusByWorktree: { [id]: [] },
    gitStatusHeadByWorktree: { [id]: 'aaa' }
  })
  const seen: { current: WorkspaceCopyStatus | null } = { current: null }
  function Probe({ open }: { open: boolean }) {
    seen.current = useWorkspaceCopyStatus({
      worktreeId: id,
      worktreePath: path,
      hostId: 'local',
      open,
      refreshOnOpen: true
    })
    return null
  }
  await act(async () => root.render(<Probe open={false} />))
  await act(async () => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  const finishPicker = deferStatus()
  await act(async () => root.render(<Probe open />))
  const target = resolveWorktreeGitCopyNow(id, 'local')
  if (!target) {
    throw new Error('Local copy unresolved')
  }
  const state = useAppStore.getState()
  await act(async () =>
    refreshGitStatusForWorktree({
      target: target.transport,
      ownerHostId: target.hostId,
      worktreeId: id,
      worktreePath: path,
      deps: {
        setGitStatus: state.setGitStatus,
        updateWorktreeGitIdentity: state.updateWorktreeGitIdentity,
        setUpstreamStatus: state.setUpstreamStatus,
        fetchUpstreamStatus: async () => null
      }
    })
  )
  await finishPicker(clean)
  expect(seen.current).toMatchObject({ statusKnown: true, entries: [] })
})

it("keeps the twin's status out after selecting it and back while a refresh is in flight", async () => {
  useAppStore.setState({
    activeWorkspaceExecutionHostId: 'local',
    gitStatusByWorktree: { [id]: [] }
  })
  const finishFirst = deferStatus()
  const seen = await readFor('local')
  await act(async () =>
    useAppStore.setState({
      activeWorkspaceExecutionHostId: 'ssh:box-b',
      gitStatusByWorktree: { [id]: [...dirty] },
      gitStatusHeadByWorktree: { [id]: 'bbb' }
    })
  )
  const finishSecond = deferStatus()
  await act(async () => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  await finishFirst(clean)
  expect(seen.current?.entries).toEqual([])
  await finishSecond(clean)
  expect(seen.current?.entries).toEqual([])
})
