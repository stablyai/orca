import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  makeAutomation,
  makeRun,
  makeWorktree
} from '@/components/automations/automations-page-fixtures'
import type { Repo } from '../../../shared/repo-types'
import {
  prepareAutomationDispatchWorkspace,
  resolveAutomationDispatchWorkspace
} from './automation-dispatch-workspace'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 1,
    ...overrides
  }
}

const workspace = makeWorktree({ id: 'repo-1::/repo/replacement', path: '/repo/replacement' })
const state = {
  repos: [makeRepo()],
  folderWorkspaces: [],
  projectGroups: [],
  allWorktrees: vi.fn(() => [workspace]),
  getKnownWorktreeById: vi.fn(),
  fetchWorktrees: vi.fn(async () => true),
  fetchFolderWorkspaces: vi.fn(async () => {}),
  createWorktree: vi.fn()
}
const ssh = { state: vi.fn(), connect: vi.fn(), needsPrompt: vi.fn() }

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/launch-worktree-background-terminals', () => ({
  launchWorktreeBackgroundTerminals: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

beforeEach(() => {
  vi.clearAllMocks()
  state.repos = [makeRepo()]
  state.allWorktrees.mockReturnValue([])
  ssh.state.mockResolvedValue({ status: 'connected' })
  ssh.connect.mockResolvedValue({ status: 'connected' })
  ssh.needsPrompt.mockResolvedValue(false)
  vi.stubGlobal('window', {
    api: {
      ssh: { getState: ssh.state, connect: ssh.connect, needsPassphrasePrompt: ssh.needsPrompt }
    }
  })
})

async function prepare() {
  const automation = makeAutomation({ workspaceMode: 'existing', workspaceId: workspace.id })
  const run = makeRun()
  const current = useAppStore.getState()
  const resolved = resolveAutomationDispatchWorkspace(current, automation, run)
  if (!resolved.repo) {
    throw new Error('Missing fixture repository')
  }
  const markDispatchResult = vi.fn()
  const prepared = await prepareAutomationDispatchWorkspace({
    state: current,
    automation,
    run,
    dispatchToken: 'token',
    resolved: { ...resolved, repo: resolved.repo },
    markDispatchResult
  })
  return { prepared, markDispatchResult }
}

describe('automation workspace refresh after host preparation', () => {
  it('uses the workspace restored by SSH reconnect instead of the pre-connect lookup', async () => {
    state.repos = [makeRepo({ connectionId: 'ssh-1' })]
    ssh.state.mockResolvedValue({ status: 'disconnected' })
    ssh.connect.mockImplementationOnce(async () => {
      state.allWorktrees.mockReturnValue([workspace])
      return { status: 'connected' }
    })
    const result = await prepare()
    expect(result.prepared).toBe(workspace)
    expect(result.markDispatchResult).not.toHaveBeenCalled()
    expect(state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('refreshes a replacement missing from the renderer catalog without creating another', async () => {
    state.fetchWorktrees.mockImplementationOnce(async () => {
      state.allWorktrees.mockReturnValue([workspace])
      return true
    })
    expect((await prepare()).prepared).toBe(workspace)
    expect(state.fetchWorktrees).toHaveBeenCalledWith('repo-1', { forceLocalOwner: true })
    expect(state.createWorktree).not.toHaveBeenCalled()
  })
})
