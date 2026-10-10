import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAgentLaunchOutcome } from './agent-launch-through-host'

const host = vi.hoisted(() => ({
  launchAgentThroughHost: vi.fn(),
  windowMakesHostLaunchTab: vi.fn(() => true)
}))
vi.mock('@/lib/agent-launch-through-host', () => host)
vi.mock('@/lib/launch-agent-tab-prompt-paste', () => ({
  pasteAgentLaunchPromptOnceReady: vi.fn()
}))
const state = vi.hoisted(() => {
  const initial: {
    settings: { disabledTuiAgents: string[] }
    connectionId: string | null | undefined
  } = { settings: { disabledTuiAgents: [] }, connectionId: null }
  return initial
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: state.settings }) } }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => state.connectionId
}))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { freshNewTabLaunchesThroughHost, launchFreshNewTabThroughHost } =
  await import('./launch-agent-new-tab-host-route')

beforeEach(() => {
  vi.clearAllMocks()
  host.windowMakesHostLaunchTab.mockReturnValue(true)
  state.settings = { disabledTuiAgents: [] }
  state.connectionId = null
})

describe('which plain new-tab launches start through the host', () => {
  function startsThroughHost(
    overrides: { prompt?: string; freshNewTab?: true } = {},
    launchPlatform: NodeJS.Platform = 'win32'
  ): boolean {
    return freshNewTabLaunchesThroughHost(
      { freshNewTab: true, worktreeId: 'wt-1', agent: 'claude', ...overrides },
      launchPlatform
    )
  }

  it('a local workspace with an enabled agent, no prompt and the chat default off', () => {
    expect(startsThroughHost()).toBe(true)
  })

  it('only for the plain new-tab callers, and only with no prompt', () => {
    expect(startsThroughHost({ freshNewTab: undefined })).toBe(false)
    expect(startsThroughHost({ prompt: 'fix it' })).toBe(false)
  })

  it('keeps main launch where the host could open a chat', () => {
    host.windowMakesHostLaunchTab.mockReturnValue(false)
    expect(startsThroughHost()).toBe(false)
  })

  // Why: the host refuses a disabled agent; main's window never read the disabled list here.
  it('keeps main launch for a disabled agent', () => {
    state.settings = { disabledTuiAgents: ['claude'] }
    expect(startsThroughHost()).toBe(false)
  })

  // Why: main's pane connects an SSH target first and waits for the remote shell before typing.
  it.each([['ssh-1'], [undefined]])('keeps main launch on SSH or an unknown host (%s)', (id) => {
    state.connectionId = id
    expect(startsThroughHost()).toBe(false)
  })

  // Why: the window launches a WSL path as Linux; the host would quote it for Windows.
  it('keeps main launch where the window launches on another platform', () => {
    expect(startsThroughHost({}, 'linux')).toBe(false)
  })
})

describe('a plain new tab started through the host', () => {
  function launch(outcome: HostAgentLaunchOutcome): string {
    host.launchAgentThroughHost.mockReturnValue({
      tabId: 'tab-1',
      outcome: Promise.resolve(outcome)
    })
    return launchFreshNewTabThroughHost({ agent: 'claude', worktreeId: 'wt-1', prompt: '' })
  }

  it('says nothing once the agent started', async () => {
    expect(launch({ kind: 'started' })).toBe('tab-1')
    await Promise.resolve()
    await Promise.resolve()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says a launch that never started, with no copy action for a prompt it never had', async () => {
    launch({ kind: 'not-started', unconfirmed: false, code: 'worktree_not_found' })
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(toast.error.mock.calls[0]?.[1]).toBeUndefined()
  })
})
