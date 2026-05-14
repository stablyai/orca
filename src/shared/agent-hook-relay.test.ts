import { describe, expect, it } from 'vitest'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD,
  ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV,
  isRemoteAgentHooksEnabled,
  type AgentHookRelayEnvelope
} from './agent-hook-relay'

describe('agent-hook-relay wire shape', () => {
  it('encodes/decodes through JSON without losing fields', () => {
    const envelope: AgentHookRelayEnvelope = {
      source: 'claude',
      paneKey: 'tab-1:0',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      env: 'production',
      version: '1',
      payload: {
        state: 'working',
        prompt: 'roundtrip',
        agentType: 'claude'
      }
    }

    const decoded = JSON.parse(JSON.stringify(envelope)) as AgentHookRelayEnvelope
    expect(decoded).toEqual(envelope)
    expect(decoded.connectionId).toBeNull()
    expect(decoded.payload.prompt).toBe('roundtrip')
  })

  it('exposes stable JSON-RPC method names', () => {
    expect(AGENT_HOOK_NOTIFICATION_METHOD).toBe('agent.hook')
    expect(AGENT_HOOK_REQUEST_REPLAY_METHOD).toBe('agent_hook.requestReplay')
    expect(AGENT_HOOK_INSTALL_PLUGINS_METHOD).toBe('agent_hook.installPlugins')
  })
})

describe('isRemoteAgentHooksEnabled', () => {
  it('is off when the env var is absent', () => {
    expect(isRemoteAgentHooksEnabled({})).toBe(false)
  })

  it('is off for empty / "0"', () => {
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '' })).toBe(false)
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '0' })).toBe(false)
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '   ' })).toBe(false)
  })

  it('is on for any other non-empty value', () => {
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: '1' })).toBe(true)
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: 'on' })).toBe(true)
    expect(isRemoteAgentHooksEnabled({ [ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]: 'true' })).toBe(true)
  })
})
