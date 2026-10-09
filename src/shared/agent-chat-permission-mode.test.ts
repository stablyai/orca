import { describe, expect, it } from 'vitest'
import {
  AGENT_CHAT_PERMISSION_MODES,
  agentChatPermissionModeFromSetting,
  agentChatPermissionModes,
  agentChatPermissionModeSupported,
  commitAgentSessionPermissionMode,
  parseAgentSessionPermissionModes,
  storedAgentChatPermissionMode,
  agentChatLaunchPermissionMode
} from './agent-chat-permission-mode'

describe('agent chat permission modes', () => {
  it('reads unknown defaults as Ask', () => {
    expect(agentChatPermissionModeFromSetting('unknown')).toBe('ask')
    expect(agentChatPermissionModeFromSetting(undefined)).toBe('ask')
  })
  it('filters defaults and saved choices with a stricter fallback', () => {
    expect(agentChatLaunchPermissionMode('codex', null, 'accept-edits')).toBe('ask')
    expect(agentChatLaunchPermissionMode('claude', null, 'auto', { autoReview: false })).toBe('ask')
    expect(agentChatLaunchPermissionMode('codex', null, 'auto', { autoReview: false })).toBe('ask')
    expect(agentChatLaunchPermissionMode('codex', { permissionMode: 'unknown' }, 'bypass')).toBe(
      'ask'
    )
    expect(
      agentChatLaunchPermissionMode('codex', { permissionMode: 'accept-edits' }, 'bypass')
    ).toBe('ask')
    expect(
      agentChatLaunchPermissionMode('claude', { permissionMode: 'accept-edits' }, 'bypass')
    ).toBe('accept-edits')
  })

  it('orders the picker from least to most access', () => {
    expect(AGENT_CHAT_PERMISSION_MODES).toEqual(['ask', 'accept-edits', 'auto', 'bypass'])
  })

  it('offers Claude every mode and Codex no edits-only mode', () => {
    expect(agentChatPermissionModes('claude')).toEqual(['ask', 'accept-edits', 'auto', 'bypass'])
    expect(agentChatPermissionModes('codex')).toEqual(['ask', 'auto', 'bypass'])
  })

  it('withholds Approve for me where the agent cannot route approvals to a reviewer', () => {
    expect(agentChatPermissionModes('claude', { autoReview: false })).toEqual([
      'ask',
      'accept-edits',
      'bypass'
    ])
    expect(agentChatPermissionModes('codex', { autoReview: false })).toEqual(['ask', 'bypass'])
  })

  it('offers no picker for any other agent', () => {
    expect(agentChatPermissionModes('gemini')).toBeNull()
    expect(agentChatPermissionModeSupported('gemini', 'ask')).toBe(false)
  })

  it('reads a stored choice only when the agent can run it', () => {
    expect(storedAgentChatPermissionMode('claude', { permissionMode: 'accept-edits' })).toBe(
      'accept-edits'
    )
    expect(storedAgentChatPermissionMode('codex', { permissionMode: 'accept-edits' })).toBeNull()
    expect(storedAgentChatPermissionMode('codex', { permissionMode: 'bypassPermissions' })).toBe(
      null
    )
    expect(storedAgentChatPermissionMode('codex', undefined)).toBeNull()
  })
})

describe('parseAgentSessionPermissionModes', () => {
  it('reads a host report', () => {
    expect(
      parseAgentSessionPermissionModes({ current: 'auto', supported: ['ask', 'auto', 'bypass'] })
    ).toEqual({ current: 'auto', supported: ['ask', 'auto', 'bypass'] })
  })

  it('keeps current intent without treating it as permission to choose Auto', () => {
    expect(
      parseAgentSessionPermissionModes({ current: 'auto', supported: ['ask', 'bypass'] })
    ).toEqual({ current: 'auto', supported: ['ask', 'bypass'] })
  })

  // An older host sends nothing, and that is what hides the picker.
  it('is null for a host that predates the picker', () => {
    expect(parseAgentSessionPermissionModes(undefined)).toBeNull()
  })

  it('drops modes a newer host adds and hides the picker for a current it cannot name', () => {
    expect(
      parseAgentSessionPermissionModes({ current: 'ask', supported: ['ask', 'plan', 'bypass'] })
    ).toEqual({ current: 'ask', supported: ['ask', 'bypass'] })
    expect(
      parseAgentSessionPermissionModes({ current: 'plan', supported: ['ask', 'plan'] })
    ).toBeNull()
  })
})

describe('commitAgentSessionPermissionMode', () => {
  it('moves the current mode within the reported list', () => {
    const reported = { current: 'ask', supported: ['ask', 'bypass'] } as const
    expect(commitAgentSessionPermissionMode(reported, 'codex', 'bypass')).toEqual({
      current: 'bypass',
      supported: ['ask', 'bypass']
    })
    expect(commitAgentSessionPermissionMode(reported, 'codex', 'auto')).toBe(reported)
  })

  // A launch seed naming a mode is the host's word that it offers the picker.
  it('stands the agent list in for a seed before any report', () => {
    expect(commitAgentSessionPermissionMode(null, 'codex', 'bypass')).toEqual({
      current: 'bypass',
      supported: ['ask', 'auto', 'bypass']
    })
    expect(commitAgentSessionPermissionMode(null, 'codex', 'accept-edits')).toBeNull()
    expect(commitAgentSessionPermissionMode(null, 'claude', 'nonsense')).toBeNull()
  })
})
