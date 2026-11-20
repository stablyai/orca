import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { useAppStore } from '@/store'
import {
  fetchRuntimeGit,
  getRuntimeGitUpstreamStatus
} from '@/runtime/source-control/git/runtime-git-sync-client'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { getRuntimeDefaultCreateProjectParent } from '../sidebar/project-admission/create/runtime-create-project-parent'
import type { OpenOnHostTarget } from './open-on-host-targets'
import {
  resolveOpenOnHostLocation,
  runOpenOnHost,
  type OpenOnHostRequest
} from './open-on-host-flow'

vi.mock('@/runtime/source-control/git/runtime-git-sync-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchRuntimeGit: vi.fn(),
  getRuntimeGitUpstreamStatus: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc: vi.fn()
}))
vi.mock('@/lib/workspace/activation/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('../sidebar/project-admission/create/runtime-create-project-parent', () => ({
  getRuntimeDefaultCreateProjectParent: vi.fn()
}))

const fetch = vi.mocked(fetchRuntimeGit)
const upstream = vi.mocked(getRuntimeGitUpstreamStatus)
const rpc = vi.mocked(callRuntimeRpc)
const activate = vi.mocked(activateAndRevealWorktree)
const defaultParent = vi.mocked(getRuntimeDefaultCreateProjectParent)
const toastError = vi.spyOn(toast, 'error')
const createWorktree = vi.fn()
const pushBranch = vi.fn()
const setupProjectClone = vi.fn()

const initialState = useAppStore.getState()

const hostRepo: Repo = {
  id: 'devdesk-repo',
  path: '/home/me/orca',
  displayName: 'orca',
  executionHostId: 'runtime:devdesk',
  badgeColor: '',
  addedAt: 0
}

const target: OpenOnHostTarget = {
  hostId: 'runtime:devdesk',
  environmentId: 'devdesk',
  label: 'devdesk',
  existingSetup: {
    id: 'setup-devdesk',
    kind: 'ready',
    projectId: 'project-1',
    hostId: 'runtime:devdesk',
    repoId: 'devdesk-repo',
    label: 'devdesk',
    detail: '',
    path: '/home/me/orca'
  },
  disabledReason: null
}
const cloneTarget: OpenOnHostTarget = { ...target, existingSetup: null }

const sourceWorktree = makeWorktree({
  id: 'mac-repo::/Users/me/orca-ws/feature-x',
  repoId: 'mac-repo',
  path: '/Users/me/orca-ws/feature-x',
  branch: 'refs/heads/feature/x',
  head: 'aaa',
  hostId: 'local'
})

const readyPlan = {
  kind: 'ready',
  sync: 'none',
  localOnlyCommits: 0,
  expectSameHead: true
} as const

const base = {
  projectId: 'project-1',
  displayName: 'orca',
  target,
  location: { kind: 'existing', repoId: 'devdesk-repo', path: '/home/me/orca' }
} as const
const workspaceRequest: OpenOnHostRequest = {
  ...base,
  workspace: { worktree: sourceWorktree, plan: readyPlan }
}
const forkRequest: OpenOnHostRequest = {
  ...base,
  workspace: {
    worktree: { ...sourceWorktree, pushTarget: { remoteName: 'fork', branchName: 'feature/x' } },
    plan: readyPlan
  }
}
const pushRequest: OpenOnHostRequest = {
  ...base,
  workspace: { worktree: sourceWorktree, plan: { ...readyPlan, sync: 'push' } }
}

beforeEach(() => {
  vi.clearAllMocks()
  upstream.mockResolvedValue({
    hasUpstream: true,
    upstreamName: 'origin/feature/x',
    ahead: 0,
    behind: 0
  })
  fetch.mockResolvedValue(undefined)
  pushBranch.mockResolvedValue(undefined)
  createWorktree.mockResolvedValue({ worktree: { id: 'w2', head: 'aaa' } })
  useAppStore.setState({
    createWorktree,
    pushBranch,
    setupProjectClone,
    repos: [hostRepo],
    projectHostSetups: []
  })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('runOpenOnHost', () => {
  it('opens a workspace from the same branch on the host', async () => {
    expect(await runOpenOnHost(workspaceRequest)).toEqual({ worktreeId: 'w2', notice: null })
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'devdesk-repo::/home/me/orca' }),
      undefined
    )
    expect(createWorktree.mock.calls[0][2]).toBe('origin/feature/x')
    expect(createWorktree.mock.calls[0][12]).toBe('feature/x')
    expect(createWorktree.mock.calls[0].at(-1)).toEqual({
      executionHostId: 'runtime:devdesk',
      branchIntent: 'open-existing-v2'
    })
    expect(activate).toHaveBeenCalledWith('w2', { executionHostId: 'runtime:devdesk' })
  })

  it('fetches the fork remote and refuses when the host clone lacks it', async () => {
    const raw = "fatal: 'fork' does not appear to be a git repository"
    fetch.mockRejectedValue(new Error(raw))
    expect(await runOpenOnHost(forkRequest)).toBeNull()
    expect(fetch).toHaveBeenCalledWith(expect.anything(), {
      remoteName: 'fork',
      branchName: 'feature/x'
    })
    expect(createWorktree).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledOnce()
    expect(toastError.mock.calls[0][0]).not.toBe(raw)
  })

  it('toasts when the host copy is not loaded', async () => {
    useAppStore.setState({ repos: [] })
    expect(await runOpenOnHost(workspaceRequest)).toBeNull()
    expect(toastError).toHaveBeenCalledOnce()
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('warns when the host opened a different commit than the source', async () => {
    createWorktree.mockResolvedValue({ worktree: { id: 'w2', head: 'bbb' } })
    expect((await runOpenOnHost(workspaceRequest))?.notice).not.toBeNull()
  })

  it('pushes before fetching when the plan says push', async () => {
    await runOpenOnHost(pushRequest)
    expect(pushBranch.mock.calls[0][2]).toBe(false)
    expect(pushBranch.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0])
  })

  it('stops without opening when the push is rejected', async () => {
    pushBranch.mockRejectedValue(
      new Error('! [rejected] feature/x -> feature/x (non-fast-forward)')
    )
    expect(await runOpenOnHost(pushRequest)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('opens a project on the host with a generated name and the default base', async () => {
    expect(await runOpenOnHost(base)).toEqual({ worktreeId: 'w2', notice: null })
    expect(createWorktree.mock.calls[0][2]).toBeUndefined()
    expect(createWorktree.mock.calls[0].at(-1)).toEqual({
      executionHostId: 'runtime:devdesk',
      nameWasGenerated: true
    })
  })
})

describe('resolveOpenOnHostLocation', () => {
  it('clones into the host-suggested folder when the default one is taken', async () => {
    defaultParent.mockResolvedValue('/home/me/orca/projects')
    rpc.mockResolvedValue({
      target: {
        status: 'taken',
        folderName: 'orca',
        reason: 'not-empty',
        suggestedFolderName: 'orca-2'
      }
    })
    expect(await resolveOpenOnHostLocation(cloneTarget, 'https://github.com/o/orca.git')).toEqual({
      kind: 'clone',
      url: 'https://github.com/o/orca.git',
      destination: '/home/me/orca/projects',
      folderName: 'orca-2'
    })
  })
})
