import { expect, it, vi } from 'vitest'
import { ProviderSession } from '../../../shared/rpc-contract/agent-session-params'
import { agentProviderSessionForHostEnsure } from './agent-session-ensure-provider-session'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: vi.fn() }))

it.each([true, false])(
  'sends a host only fields its strict schema accepts (effort supported: %s)',
  async (supportsEffort) => {
    vi.mocked(runtimeEnvironmentSupportsCapability).mockResolvedValue(supportsEffort)
    const sent = await agentProviderSessionForHostEnsure('env-1', {
      key: 'session_id',
      id: 'claude-session',
      cwd: '/repo',
      effort: 'max',
      permissionMode: 'bypassPermissions'
    })

    expect(sent).toEqual({
      key: 'session_id',
      id: 'claude-session',
      ...(supportsEffort ? { effort: 'max' } : {})
    })
    expect(ProviderSession.safeParse(sent).success).toBe(true)
  }
)
