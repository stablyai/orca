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
vi.mock('./orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: () => host.cloud
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

  it('expired: holds, then starts on Renew', async () => {
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
    await expect(result).resolves.toBe(AGENT)
    // Renew's auto-start: the original args, no focus taken (the tab may be in the background).
    expect(create).toHaveBeenLastCalledWith(args)
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

  it('a host that cannot open the placeholder creates as before rather than blocking', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const create = vi.fn(async (args: { launchAgent?: string }) =>
      args.launchAgent ? AGENT : { outcome: { status: 'failed' as const, message: 'x' } }
    )
    await expect(createWithCloudAgentHold(CREATE_AGENT, create)).resolves.toBe(AGENT)
  })
})
