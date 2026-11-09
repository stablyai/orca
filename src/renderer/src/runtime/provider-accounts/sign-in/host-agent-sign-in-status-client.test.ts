import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE } from '../../../../../shared/remote-runtime/recipe-vm-wake'

const mocks = vi.hoisted(() => ({
  supported: true,
  call: vi.fn(),
  addClaude: vi.fn(),
  addCodex: vi.fn(),
  selectClaude: vi.fn(),
  selectCodex: vi.fn()
}))

vi.mock('../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn(async () => mocks.supported)
}))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('./runtime-host-account-sign-in-client', () => ({
  addClaudeAccountOnHost: mocks.addClaude,
  addCodexAccountOnHost: mocks.addCodex
}))
vi.mock('../observations/runtime-provider-accounts-client', () => ({
  selectClaudeProviderAccount: mocks.selectClaude,
  selectCodexProviderAccount: mocks.selectCodex
}))

import {
  _resetHostAgentSignInStatusForTest,
  readHostAgentSignInStatus,
  refreshHostAgentSignInStatus,
  signInAgentOnHost
} from './host-agent-sign-in-status-client'

const REPORT = { checkedAt: 1, agents: [{ agent: 'claude', state: 'signedOut' }] }

beforeEach(() => {
  _resetHostAgentSignInStatusForTest()
  vi.clearAllMocks()
  mocks.supported = true
  mocks.call.mockResolvedValue(REPORT)
})

describe('host agent sign-in status client', () => {
  it('shows a sleeping VM as asleep, not as a failed check', async () => {
    mocks.call.mockRejectedValue(
      Object.assign(new Error('asleep'), { code: RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE })
    )
    await refreshHostAgentSignInStatus('vm')
    expect(readHostAgentSignInStatus('vm')).toEqual({ phase: 'asleep' })
  })

  it('shows nothing for a host whose Orca predates the check', async () => {
    mocks.supported = false
    await refreshHostAgentSignInStatus('old')
    expect(readHostAgentSignInStatus('old')).toEqual({ phase: 'unsupported' })
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('makes a new sign-in the host account only when none was chosen', async () => {
    mocks.addClaude.mockResolvedValue({
      accounts: [
        { id: 'old', createdAt: 1 },
        { id: 'new', createdAt: 2 }
      ],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    })
    await signInAgentOnHost('vm', 'claude')
    expect(mocks.selectClaude).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'vm' },
      { accountId: 'new', runtime: 'host' }
    )

    mocks.addCodex.mockResolvedValue({
      accounts: [
        { id: 'chosen', createdAt: 1 },
        { id: 'new', createdAt: 2 }
      ],
      activeAccountId: 'chosen'
    })
    await signInAgentOnHost('vm', 'codex')
    expect(mocks.selectCodex).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'vm' },
      'accounts.agentSignInStatus',
      { force: true },
      expect.anything()
    )
  })
})
