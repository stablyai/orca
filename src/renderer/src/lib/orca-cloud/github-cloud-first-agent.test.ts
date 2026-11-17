// @vitest-environment happy-dom
// The first agent of a GitHub-only Orca Cloud create (after the build
// sheet's hand-off) starts once per create, even with no prompt (its launch is what
// shows "isn't set up · Set up once" when it can't run yet); a repo still cloning is waited for, a
// host not confirmed Orca Cloud gets no agent, and a wait that runs out says so.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => {
  const state: {
    opened: { ok: true; worktreeId: string | null; hostId?: string }
    worktree: string | null
    launches: { agent: string; prompt?: string; worktreeId: string }[]
    toasts: string[]
    dismissed: string[]
    cloud: boolean
    lastArgs: Record<string, unknown> | null
    branchFails: boolean
    activated: string[]
  } = {
    cloud: true,
    branchFails: false,
    activated: [],
    lastArgs: null,
    opened: { ok: true, worktreeId: 'wt-1' },
    worktree: null,
    launches: [],
    toasts: [],
    dismissed: []
  }
  return state
})

vi.mock('sonner', () => {
  const toast = Object.assign((text: string) => mocks.toasts.push(text), {
    loading: () => 'toast-1',
    error: (text: string) => mocks.toasts.push(text),
    dismiss: (id?: string) => {
      if (id) {
        mocks.dismissed.push(id)
      }
    }
  })
  return { toast }
})
vi.mock('@/components/cloud-workspaces/open-cloud-workspace', () => ({
  firstWorktreeOnHost: () => mocks.worktree
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: (args: {
    agent: string
    prompt?: string
    worktreeId: string
  }) => {
    mocks.lastArgs = args
    mocks.launches.push({ agent: args.agent, prompt: args.prompt, worktreeId: args.worktreeId })
  }
}))
// The workspace's own branch is `<clone>+ws`; a failed one starts no agent on the default branch.
vi.mock('./github-cloud-workspace-branch', () => ({
  createGitHubCloudWorkspaceBranch: async (args: { primaryWorktreeId: string }) =>
    mocks.branchFails ? null : `${args.primaryWorktreeId}+ws`
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: (id: string) => mocks.activated.push(id)
}))
vi.mock('./orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentForLaunch: async () => mocks.cloud
}))
vi.mock('@/lib/agent-session/launch/pane/agent-tab-launch-context', () => ({
  captureAgentTabLaunchContext: () => ({})
}))

const { launchFirstCloudAgent } = await import('./github-cloud-first-agent')

const startCloudWorkspaceFromGitHub = (r: { agent: string | null }) =>
  launchFirstCloudAgent({ fullName: 'acme/web', name: 'gc-1', ...r, ...mocks.opened })

const request = (agent: string | null = 'claude') => ({ agent })

beforeEach(() => {
  mocks.opened = { ok: true, worktreeId: 'wt-1' }
  mocks.worktree = null
  mocks.launches = []
  mocks.toasts = []
  mocks.dismissed = []
  mocks.cloud = true
  mocks.branchFails = false
  mocks.activated = []
})
afterEach(() => vi.useRealTimers())

describe('launchFirstCloudAgent', () => {
  it('starts the chosen agent with no prompt, once', async () => {
    await startCloudWorkspaceFromGitHub(request())
    expect(mocks.launches).toEqual([{ agent: 'claude', prompt: undefined, worktreeId: 'wt-1+ws' }])
  })

  it('starts it the way the composer picked: a chat, with its setup', async () => {
    await launchFirstCloudAgent({
      fullName: 'acme/web',
      name: 'gc-1',
      agent: 'claude',
      launch: { requestedSurface: 'chat', chatSessionOptions: { model: 'opus' } },
      ...mocks.opened
    })
    expect(mocks.lastArgs).toMatchObject({
      agent: 'claude',
      worktreeId: 'wt-1+ws',
      requestedSurface: 'chat',
      chatSessionOptions: { model: 'opus' }
    })
  })

  it('opens the workspace on its own branch, never the clone on the default branch', async () => {
    await startCloudWorkspaceFromGitHub(request())
    expect(mocks.activated).toEqual(['wt-1+ws'])
    expect(mocks.launches.map((launch) => launch.worktreeId)).toEqual(['wt-1+ws'])
  })

  it('a branch that cannot be made starts no agent and says so', async () => {
    mocks.branchFails = true
    await startCloudWorkspaceFromGitHub(request())
    expect(mocks.launches).toEqual([])
    expect(mocks.toasts.at(-1)).toContain('Couldn’t create a branch for this workspace')
  })

  it('Blank terminal starts nothing, not the default agent', async () => {
    await startCloudWorkspaceFromGitHub(request(null))
    expect(mocks.launches).toEqual([])
  })

  it('a repo still cloning is waited for, then the agent starts', async () => {
    mocks.opened = { ok: true, worktreeId: null, hostId: 'runtime:env-1' }
    const started = startCloudWorkspaceFromGitHub(request())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.launches).toEqual([])
    mocks.worktree = 'wt-late'
    useAppStore.setState({})
    await started
    expect(mocks.launches).toEqual([
      { agent: 'claude', prompt: undefined, worktreeId: 'wt-late+ws' }
    ])
  })

  it('a wait that runs out says so and starts nothing', async () => {
    vi.useFakeTimers()
    mocks.opened = { ok: true, worktreeId: null, hostId: 'runtime:env-1' }
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const started = startCloudWorkspaceFromGitHub(request())
    await vi.advanceTimersByTimeAsync(90_000)
    await started
    expect(mocks.launches).toEqual([])
    expect(mocks.toasts.at(-1)).toBe(
      'Claude didn’t start because the workspace was still getting ready. Start it from the workspace.'
    )
    expect(info).toHaveBeenCalledWith(expect.stringContaining('agent was not started'))
    info.mockRestore()
  })

  it('a host never confirmed as Orca Cloud gets no agent, and says so', async () => {
    vi.useFakeTimers()
    mocks.opened = { ok: true, worktreeId: 'wt-1', hostId: 'runtime:env-1' }
    mocks.cloud = false
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const started = startCloudWorkspaceFromGitHub(request())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.launches).toEqual([])
    mocks.cloud = true
    await vi.advanceTimersByTimeAsync(1_000)
    await started
    expect(mocks.launches).toEqual([{ agent: 'claude', prompt: undefined, worktreeId: 'wt-1+ws' }])
    mocks.launches = []
    mocks.cloud = false
    const never = startCloudWorkspaceFromGitHub(request())
    await vi.advanceTimersByTimeAsync(91_000)
    await never
    expect(mocks.launches).toEqual([])
    expect(mocks.toasts.at(-1)).toContain(
      'didn’t start because the workspace was still getting ready'
    )
    info.mockRestore()
  })

  it('the notice goes away if the workspace becomes ready after all', async () => {
    vi.useFakeTimers()
    mocks.opened = { ok: true, worktreeId: null, hostId: 'runtime:env-1' }
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const started = startCloudWorkspaceFromGitHub(request())
    await vi.advanceTimersByTimeAsync(90_000)
    await started
    mocks.worktree = 'wt-late'
    useAppStore.setState({})
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.dismissed).toContain('cloud-agent-not-started:runtime:env-1')
    info.mockRestore()
  })
})
