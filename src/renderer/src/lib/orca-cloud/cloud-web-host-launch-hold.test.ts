// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  setOrcaCloudAgentAccountsStateForTest,
  type OrcaCloudAgentAccountsState
} from './orca-cloud-agent-accounts-store'
import {
  cloudTabHoldKey,
  readCloudAgentHold,
  releaseCloudAgentHold
} from './cloud-agent-launch-hold'

const host = vi.hoisted(() => ({
  close: vi.fn(),
  cloud: true
}))

vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: host.close
}))
vi.mock('@/runtime/hosted-terminals/placement/web-session-terminal-placement', () => ({
  webTerminalPlacementParentTabId: (id: string) => id
}))
// FAIL-CLOSED (#568): the hold asks the async launch check (store flag, then main's records).
vi.mock('./orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: () => host.cloud,
  isOrcaCloudEnvironmentForLaunch: async () => host.cloud
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const { createWithCloudAgentHold } = await import('./cloud-web-host-launch-hold')
const { toWebTerminalSurfaceTabId } =
  await import('../../../../shared/workspace-layout/terminal-surface-id')

function accounts(
  claude: OrcaCloudAgentsStatus['credentials']['claude']
): OrcaCloudAgentAccountsState {
  return {
    load: {
      kind: 'ready',
      status: {
        credentials: {
          claude,
          codex: { state: 'none' },
          providerEnabled: { claude: true, codex: true }
        },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  }
}

// A create's first agent as the after-wake seeding sends it: the startup command already carries
// the prompt (preparedAgentCommand), so it never passes through launchAgentInWebHostTab.
const CREATE_AGENT = {
  worktreeId: 'w1',
  environmentId: 'env-cloud',
  command: "claude 'say hello'",
  launchAgent: 'claude' as const,
  preparedAgentCommand: true,
  activate: false,
  selectWorktree: false
}
const PLACEHOLDER = { outcome: { status: 'created' }, hostTabId: 'h1' } as const
const AGENT = { outcome: { status: 'created' }, hostTabId: 'h2' } as const
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function hostCreate() {
  return vi.fn(async (args: { launchAgent?: string; agent?: string }) =>
    args.launchAgent || args.agent ? AGENT : PLACEHOLDER
  )
}

describe('createWithCloudAgentHold (the one hold for every Orca Cloud agent launch)', () => {
  beforeEach(() => {
    host.close.mockReset().mockResolvedValue('applied')
    host.cloud = true
  })

  it('creates at once when the Orca account is ready', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    const create = hostCreate()
    await expect(createWithCloudAgentHold(CREATE_AGENT, create)).resolves.toBe(AGENT)
    expect(create).toHaveBeenCalledExactlyOnceWith(CREATE_AGENT)
  })

  it('never holds a non-cloud host, a non-account agent, a plain shell or a resume', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const create = hostCreate()
    host.cloud = false
    await createWithCloudAgentHold(CREATE_AGENT, create)
    host.cloud = true
    await createWithCloudAgentHold({ ...CREATE_AGENT, launchAgent: 'gemini' }, create)
    await createWithCloudAgentHold({ worktreeId: 'w1', environmentId: 'env-cloud' }, create)
    await createWithCloudAgentHold({ ...CREATE_AGENT, agentSessionKind: 'resume' }, create)
    expect(create).toHaveBeenCalledTimes(4)
    expect(readCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')))).toBeNull()
  })

  it('Start focuses the agent’s tab after the placeholder closes (its neighbour would win)', async () => {
    const { useAppStore } = await import('@/store')
    const { makeTerminalTab } = await import('@/store/terminals/terminal-row.test-fixture')
    const agentTab = toWebTerminalSurfaceTabId('h2')
    useAppStore.setState({
      tabsByWorktree: {
        w1: [
          makeTerminalTab({ id: 'plain-terminal', worktreeId: 'w1' }),
          makeTerminalTab({ id: agentTab, worktreeId: 'w1' })
        ]
      }
    })
    const setActiveTab = vi.spyOn(useAppStore.getState(), 'setActiveTab')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const result = createWithCloudAgentHold(CREATE_AGENT, hostCreate())
    await flush()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'proceed')
    await result
    await flush()
    expect(setActiveTab).toHaveBeenCalledWith(agentTab)
    setActiveTab.mockRestore()
  })

  it('Start focuses the agent’s tab even when it reaches the store after the placeholder closes (create flow)', async () => {
    const { useAppStore } = await import('@/store')
    const { makeTerminalTab } = await import('@/store/terminals/terminal-row.test-fixture')
    const agentTab = toWebTerminalSurfaceTabId('h2')
    const plain = makeTerminalTab({ id: 'plain-terminal', worktreeId: 'w1' })
    useAppStore.setState({ tabsByWorktree: { w1: [plain] }, activeTabId: 'plain-terminal' })
    const setActiveTab = vi.spyOn(useAppStore.getState(), 'setActiveTab')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const result = createWithCloudAgentHold(CREATE_AGENT, hostCreate())
    await flush()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'proceed')
    await result
    await flush()
    // The placeholder is gone and its neighbour is active; the agent's tab arrives with the host sync.
    expect(setActiveTab).not.toHaveBeenCalled()
    useAppStore.setState({
      tabsByWorktree: { w1: [plain, makeTerminalTab({ id: agentTab, worktreeId: 'w1' })] }
    })
    expect(setActiveTab).toHaveBeenCalledExactlyOnceWith(agentTab)
    setActiveTab.mockRestore()
  })

  it('a late agent tab never takes focus from a tab the person picked meanwhile', async () => {
    const { useAppStore } = await import('@/store')
    const { makeTerminalTab } = await import('@/store/terminals/terminal-row.test-fixture')
    const agentTab = toWebTerminalSurfaceTabId('h2')
    const plain = makeTerminalTab({ id: 'plain-terminal', worktreeId: 'w1' })
    const other = makeTerminalTab({ id: 'other', worktreeId: 'w1' })
    useAppStore.setState({ tabsByWorktree: { w1: [plain, other] }, activeTabId: 'plain-terminal' })
    const setActiveTab = vi.spyOn(useAppStore.getState(), 'setActiveTab')
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const result = createWithCloudAgentHold(CREATE_AGENT, hostCreate())
    await flush()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'proceed')
    await result
    await flush()
    useAppStore.setState({ activeTabId: 'other' })
    useAppStore.setState({
      tabsByWorktree: { w1: [plain, other, makeTerminalTab({ id: agentTab, worktreeId: 'w1' })] }
    })
    expect(setActiveTab).not.toHaveBeenCalled()
    setActiveTab.mockRestore()
  })

  it("a create's first Claude that isn't set up holds on a plain shell, then starts unchanged (prompt included) on Start", async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const create = hostCreate()
    const result = createWithCloudAgentHold(CREATE_AGENT, create)
    await flush()
    // The placeholder is a plain shell in the same place: no command, no agent.
    expect(create).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'w1',
      environmentId: 'env-cloud',
      activate: false,
      selectWorktree: false
    })
    const key = cloudTabHoldKey(toWebTerminalSurfaceTabId('h1'))
    expect(readCloudAgentHold(key)).toMatchObject({ agent: 'claude', reason: 'notSetUp' })
    // Set up finishes; the strip offers Start, and only Start launches the agent.
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await flush()
    expect(create).toHaveBeenCalledOnce()
    releaseCloudAgentHold(key, 'proceed')
    await expect(result).resolves.toBe(AGENT)
    // The original launch, untouched: its command still carries the first prompt.
    // Started by the person's click: the agent's tab comes forward.
    expect(create).toHaveBeenLastCalledWith({ ...CREATE_AGENT, activate: true })
    expect(host.close).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: toWebTerminalSurfaceTabId('h1'), reason: 'user' })
    )
  })

  it('exactly once: one create with a queued prompt shows one strip and starts the agent once', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const create = hostCreate()
    const launch = { ...CREATE_AGENT, prompt: 'say hello' }
    const result = createWithCloudAgentHold(launch, create)
    await flush()
    const key = cloudTabHoldKey(toWebTerminalSurfaceTabId('h1'))
    // One strip, carrying the queued prompt; no hold anywhere else (the agent's create isn't held again).
    expect(readCloudAgentHold(key)).toMatchObject({ agent: 'claude', prompt: 'say hello' })
    expect(readCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h2')))).toBeNull()
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    releaseCloudAgentHold(key, 'proceed')
    await expect(result).resolves.toBe(AGENT)
    const agentCreates = create.mock.calls.filter(([args]) => args.launchAgent === 'claude')
    // The prompt rides in the prepared command, delivered once by the one agent create.
    expect(agentCreates).toEqual([[{ ...launch, activate: true }]])
    expect(create).toHaveBeenCalledTimes(2)
    expect(readCloudAgentHold(key)).toBeNull()
  })

  it('expired: holds; Renew turns it to "renewed · Start", and Start launches it (B)', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const create = hostCreate()
    const args = { ...CREATE_AGENT, prompt: 'fix the bug' }
    const result = createWithCloudAgentHold(args, create)
    await flush()
    const key = cloudTabHoldKey(toWebTerminalSurfaceTabId('h1'))
    expect(readCloudAgentHold(key)).toMatchObject({
      reason: 'accountExpired',
      prompt: 'fix the bug'
    })
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await flush()
    // A renewal never launches by itself (team-lead, B): it waits for Start.
    expect(readCloudAgentHold(key)).toMatchObject({ reason: 'awaitingStart', awaiting: 'renewed' })
    expect(create).toHaveBeenCalledOnce()
    releaseCloudAgentHold(key, 'proceed')
    await expect(result).resolves.toBe(AGENT)
    // The person's Start: the original args, with its tab brought forward.
    expect(create).toHaveBeenLastCalledWith({ ...args, activate: true })
  })

  it('cancel leaves the plain shell and never starts the agent', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const create = hostCreate()
    const result = createWithCloudAgentHold(CREATE_AGENT, create)
    await flush()
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'cancel')
    await expect(result).resolves.toBe(PLACEHOLDER)
    expect(create).toHaveBeenCalledOnce()
    expect(host.close).not.toHaveBeenCalled()
  })

  it('FAIL-CLOSED: a host that cannot open the placeholder never gets the agent unheld', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const failed = { outcome: { status: 'failed' as const, message: 'x' } }
    const create = vi.fn(async (args: { launchAgent?: string }) =>
      args.launchAgent ? AGENT : failed
    )
    await expect(createWithCloudAgentHold(CREATE_AGENT, create)).resolves.toBe(failed)
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0]).not.toHaveProperty('launchAgent')
  })

  it('FAIL-CLOSED: a paired-from-birth launch with no Claude set up never launches Claude', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const create = hostCreate()
    void createWithCloudAgentHold({ ...CREATE_AGENT, environmentId: 'env-paired' }, create)
    await flush()
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0]).not.toHaveProperty('launchAgent')
    expect(readCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')))).not.toBeNull()
  })
})

describe('NOACCT-MISLABEL: no Claude account is a setup hold, never "didn’t start"', () => {
  beforeEach(() => {
    host.close.mockReset().mockResolvedValue('applied')
    host.cloud = true
  })

  it('a no-account cloud create holds (setup reason) instead of launching', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const create = hostCreate()
    void createWithCloudAgentHold(CREATE_AGENT, create)
    await flush()
    const hold = readCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')))
    expect(hold?.reason).toBe('notSetUp')
    // Only the plain shell so far: the agent never started into its own /login.
    expect(create).toHaveBeenCalledTimes(1)
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'cancel')
  })

  it('a hold that ends because its workspace went away shows no "didn’t start" toast', async () => {
    const { useAppStore } = await import('@/store')
    const { toast } = await import('sonner')
    vi.mocked(toast).mockClear()
    useAppStore.setState({ tabsByWorktree: {} })
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const result = createWithCloudAgentHold(CREATE_AGENT, hostCreate())
    await flush()
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'cancel')
    await result
    expect(toast).not.toHaveBeenCalled()
  })

  it('the person’s own Cancel, with the shell still open, still confirms it', async () => {
    const { useAppStore } = await import('@/store')
    const { makeTerminalTab } = await import('@/store/terminals/terminal-row.test-fixture')
    const { toast } = await import('sonner')
    vi.mocked(toast).mockClear()
    useAppStore.setState({
      activeView: 'terminal',
      activeWorktreeId: 'w1',
      tabsByWorktree: {
        w1: [makeTerminalTab({ id: toWebTerminalSurfaceTabId('h1'), worktreeId: 'w1' })]
      }
    })
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
    const result = createWithCloudAgentHold(CREATE_AGENT, hostCreate())
    await flush()
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'cancel')
    await result
    expect(toast).toHaveBeenCalledWith('The agent didn’t start. The shell is still open.')
  })

  it('never confirms a cancel over another workspace or Settings (N-03)', async () => {
    const { useAppStore } = await import('@/store')
    const { makeTerminalTab } = await import('@/store/terminals/terminal-row.test-fixture')
    const { toast } = await import('sonner')
    const tabs = {
      w1: [makeTerminalTab({ id: toWebTerminalSurfaceTabId('h1'), worktreeId: 'w1' })]
    }
    const cancelHold = async (): Promise<void> => {
      setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'none' }))
      const result = createWithCloudAgentHold(CREATE_AGENT, hostCreate())
      await flush()
      releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'cancel')
      await result
    }
    vi.mocked(toast).mockClear()
    useAppStore.setState({
      activeView: 'terminal',
      activeWorktreeId: 'other',
      tabsByWorktree: tabs
    })
    await cancelHold()
    useAppStore.setState({ activeView: 'settings', activeWorktreeId: 'w1', tabsByWorktree: tabs })
    await cancelHold()
    expect(toast).not.toHaveBeenCalled()
  })
})
