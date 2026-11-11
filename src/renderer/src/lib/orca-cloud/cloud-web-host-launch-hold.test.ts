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

const created = vi.hoisted(() => ({
  create: vi.fn(),
  close: vi.fn(),
  cloud: true
}))

vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: created.create
}))
vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: created.close
}))
vi.mock('@/runtime/hosted-terminals/placement/web-session-terminal-placement', () => ({
  webTerminalPlacementParentTabId: (id: string) => id
}))
vi.mock('./orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: () => created.cloud
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-web-host-tab', () => ({
  launchAgentInWebHostTab: vi.fn()
}))

const { launchWithCloudAgentHold } = await import('./cloud-web-host-launch-hold')
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

const REQUEST = {
  agent: 'claude' as const,
  worktreeId: 'w1',
  environmentId: 'env-cloud',
  prompt: 'fix the bug'
}
const DONE = { delivered: true, failureNotified: false }
const CANCELLED = { delivered: false, failureNotified: true }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('launchWithCloudAgentHold (RA-1: host-published cloud launches)', () => {
  beforeEach(() => {
    created.create
      .mockReset()
      .mockResolvedValue({ outcome: { status: 'created' }, hostTabId: 'h1' })
    created.close.mockReset().mockResolvedValue('applied')
    created.cloud = true
  })

  it('starts at once when the Orca account is ready', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    const launch = vi.fn().mockResolvedValue(DONE)
    await expect(launchWithCloudAgentHold(REQUEST, launch, () => CANCELLED)).resolves.toBe(DONE)
    expect(launch).toHaveBeenCalledOnce()
    expect(created.create).not.toHaveBeenCalled()
  })

  it('never holds a non-cloud host or a non-account agent', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    created.cloud = false
    const launch = vi.fn().mockResolvedValue(DONE)
    await launchWithCloudAgentHold(REQUEST, launch, () => CANCELLED)
    created.cloud = true
    await launchWithCloudAgentHold({ ...REQUEST, agent: 'gemini' }, launch, () => CANCELLED)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(created.create).not.toHaveBeenCalled()
  })

  it('expired: holds the agent on a plain shell tab whose first pane shows the strip, then starts it on Renew', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'revoked' }))
    const launch = vi.fn().mockResolvedValue(DONE)
    const result = launchWithCloudAgentHold(REQUEST, launch, () => CANCELLED)
    await flush()
    // The placeholder is a plain shell: no command, no agent.
    expect(created.create).toHaveBeenCalledWith({ worktreeId: 'w1', environmentId: 'env-cloud' })
    const key = cloudTabHoldKey(toWebTerminalSurfaceTabId('h1'))
    expect(readCloudAgentHold(key)).toMatchObject({ agent: 'claude', prompt: 'fix the bug' })
    expect(launch).not.toHaveBeenCalled()
    // Renew in S0 makes the account usable: every held launch starts.
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'active' }))
    await expect(result).resolves.toBe(DONE)
    expect(launch).toHaveBeenCalledOnce()
    expect(readCloudAgentHold(key)).toBeNull()
    expect(created.close).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: toWebTerminalSurfaceTabId('h1'), reason: 'user' })
    )
  })

  it('cancel leaves the plain shell and never starts the agent', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    const launch = vi.fn().mockResolvedValue(DONE)
    const result = launchWithCloudAgentHold(REQUEST, launch, () => CANCELLED)
    await flush()
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'cancel')
    await expect(result).resolves.toBe(CANCELLED)
    expect(launch).not.toHaveBeenCalled()
    expect(created.close).not.toHaveBeenCalled()
  })

  it('a host that cannot open the placeholder launches as before rather than blocking', async () => {
    setOrcaCloudAgentAccountsStateForTest(accounts({ state: 'expired' }))
    created.create.mockResolvedValue({ outcome: { status: 'failed', message: 'x' } })
    const launch = vi.fn().mockResolvedValue(DONE)
    await expect(launchWithCloudAgentHold(REQUEST, launch, () => CANCELLED)).resolves.toBe(DONE)
  })
})
