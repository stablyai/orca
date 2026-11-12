// @vitest-environment happy-dom
// PAIRED-HELD-STRIPS: "Start in Orca Cloud" from a GitHub-only repo starts the chosen agent once per
// create, even with no prompt (its launch is what shows "isn't set up · Set up once" when it can't
// run yet); a repo still cloning is waited for, and a wait that runs out says so.
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
  } = {
    cloud: true,
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
  openCloudWorkspace: async () => mocks.opened,
  firstWorktreeOnHost: () => mocks.worktree
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: (args: {
    agent: string
    prompt?: string
    worktreeId: string
  }) => {
    mocks.launches.push({ agent: args.agent, prompt: args.prompt, worktreeId: args.worktreeId })
  }
}))
vi.mock('./orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentForLaunch: async () => mocks.cloud
}))
vi.mock('@/components/agent-tab-launch-context', () => ({
  captureAgentTabLaunchContext: () => ({})
}))
vi.mock('@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts', () => ({
  resolveDefaultAgentForWorktree: async () => 'claude'
}))

const { startCloudWorkspaceFromGitHub } = await import('./start-cloud-workspace-from-github')

const request = (prompt: string, agent: string | null = 'claude') => ({
  repoUrl: 'https://github.com/acme/web',
  fullName: 'acme/web',
  prompt,
  agent
})

beforeEach(() => {
  mocks.opened = { ok: true, worktreeId: 'wt-1' }
  mocks.worktree = null
  mocks.launches = []
  mocks.toasts = []
  mocks.dismissed = []
  mocks.cloud = true
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      orcaCloudWorkspace: {
        createFromGitHub: async () => ({ ok: true, value: { sandboxId: 'sbx_1' } })
      },
      cloudWorkspaces: { get: async () => ({ ok: true, value: { workspaceId: 'sbx_1' } }) }
    }
  })
})
afterEach(() => vi.useRealTimers())

describe('startCloudWorkspaceFromGitHub', () => {
  it('starts the chosen agent with no prompt, once', async () => {
    await startCloudWorkspaceFromGitHub(request(''))
    expect(mocks.launches).toEqual([{ agent: 'claude', prompt: undefined, worktreeId: 'wt-1' }])
  })

  it('sends a typed prompt with it', async () => {
    await startCloudWorkspaceFromGitHub(request('fix the flaky test'))
    expect(mocks.launches).toEqual([
      { agent: 'claude', prompt: 'fix the flaky test', worktreeId: 'wt-1' }
    ])
  })

  it('no agent chosen and no prompt: starts nothing', async () => {
    await startCloudWorkspaceFromGitHub(request('', null))
    expect(mocks.launches).toEqual([])
  })

  it('a repo still cloning is waited for, then the agent starts', async () => {
    mocks.opened = { ok: true, worktreeId: null, hostId: 'runtime:env-1' }
    const started = startCloudWorkspaceFromGitHub(request(''))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.launches).toEqual([])
    mocks.worktree = 'wt-late'
    useAppStore.setState({})
    await started
    expect(mocks.launches).toEqual([{ agent: 'claude', prompt: undefined, worktreeId: 'wt-late' }])
  })

  it('a wait that runs out says so and starts nothing', async () => {
    vi.useFakeTimers()
    mocks.opened = { ok: true, worktreeId: null, hostId: 'runtime:env-1' }
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const started = startCloudWorkspaceFromGitHub(request(''))
    await vi.advanceTimersByTimeAsync(90_000)
    await started
    expect(mocks.launches).toEqual([])
    expect(mocks.toasts.at(-1)).toBe(
      'Claude didn’t start because the workspace was still getting ready. Start it from the workspace.'
    )
    expect(info).toHaveBeenCalledWith(expect.stringContaining('agent was not started'))
    info.mockRestore()
  })

  it('FAIL-CLOSED: a host never confirmed as Orca Cloud gets no agent, and says so', async () => {
    vi.useFakeTimers()
    mocks.opened = { ok: true, worktreeId: 'wt-1', hostId: 'runtime:env-1' }
    mocks.cloud = false
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const started = startCloudWorkspaceFromGitHub(request(''))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.launches).toEqual([])
    mocks.cloud = true
    await vi.advanceTimersByTimeAsync(1_000)
    await started
    expect(mocks.launches).toEqual([{ agent: 'claude', prompt: undefined, worktreeId: 'wt-1' }])
    mocks.launches = []
    mocks.cloud = false
    const never = startCloudWorkspaceFromGitHub(request(''))
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
    const started = startCloudWorkspaceFromGitHub(request(''))
    await vi.advanceTimersByTimeAsync(90_000)
    await started
    expect(mocks.dismissed).toEqual(['toast-1'])
    mocks.worktree = 'wt-late'
    useAppStore.setState({})
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.dismissed).toContain('cloud-agent-not-started:runtime:env-1')
    info.mockRestore()
  })
})
