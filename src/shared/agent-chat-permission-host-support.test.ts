import { describe, expect, it } from 'vitest'
import {
  chatPermissionHostVerdict,
  hostSettingsApplyChatPermissionModes,
  legacyHostChatPermissionMode
} from './agent-chat-permission-host-support'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import { AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY } from './agent-session-permission-modes-capability'

describe('what a host predating per-chat modes runs', () => {
  it('is Full access on its default Agent Permissions, which carry the bypass flag', () => {
    expect(legacyHostChatPermissionMode('claude', { agentDefaultArgs: {} })).toBe('full-access')
    expect(legacyHostChatPermissionMode('codex', {})).toBe('full-access')
  })

  it('is Ask once the host switched that agent to Manual', () => {
    expect(legacyHostChatPermissionMode('claude', { agentDefaultArgs: { claude: '' } })).toBe('ask')
    expect(
      legacyHostChatPermissionMode('codex', { agentDefaultArgs: { codex: '--model x' } })
    ).toBe('ask')
  })

  it('reads a bypass flag any shell the host might use would pass', () => {
    expect(
      legacyHostChatPermissionMode('claude', {
        agentDefaultArgs: { claude: '--verbose --dangerously-skip-permissions' }
      })
    ).toBe('full-access')
  })

  it('names no mode for an agent without chat modes', () => {
    // Grok gained chat modes in #29335; Gemini still has none.
    expect(legacyHostChatPermissionMode('gemini', {})).toBeNull()
  })
})

describe('whether a host applies per-chat modes', () => {
  it('is told by the new-chat default its settings carry from 1.4.225 on', () => {
    expect(hostSettingsApplyChatPermissionModes({ nativeChatPermissionMode: 'ask' })).toBe(true)
    expect(hostSettingsApplyChatPermissionModes({ agentDefaultArgs: {} })).toBe(false)
    expect(hostSettingsApplyChatPermissionModes(undefined)).toBe(false)
  })

  it('is advertised by this build', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY)
  })
})

describe('the verdict on a chat start or turn', () => {
  const legacy = { agent: 'claude', hostAppliesModes: false } as const

  it('refuses an older host that would run with more access than asked for', () => {
    expect(
      chatPermissionHostVerdict({ ...legacy, legacyMode: 'full-access', requested: 'ask' })
    ).toEqual({ kind: 'refused', hostMode: 'full-access' })
    expect(
      chatPermissionHostVerdict({ ...legacy, legacyMode: 'full-access', requested: 'auto' }).kind
    ).toBe('refused')
  })

  it('reads an unknown or missing request as Ask, never as more access', () => {
    expect(
      chatPermissionHostVerdict({ ...legacy, legacyMode: 'full-access', requested: undefined }).kind
    ).toBe('refused')
    expect(
      chatPermissionHostVerdict({ ...legacy, legacyMode: 'full-access', requested: 'yolo' }).kind
    ).toBe('refused')
  })

  it('refuses a host whose Agent Permissions could not be read', () => {
    expect(
      chatPermissionHostVerdict({ ...legacy, legacyMode: undefined, requested: 'ask' })
    ).toEqual({ kind: 'refused', hostMode: null })
  })

  it('allows an older host that runs no more access than asked for', () => {
    expect(chatPermissionHostVerdict({ ...legacy, legacyMode: 'ask', requested: 'ask' }).kind).toBe(
      'allowed'
    )
    expect(
      chatPermissionHostVerdict({ ...legacy, legacyMode: 'full-access', requested: 'full-access' })
        .kind
    ).toBe('allowed')
  })

  it('allows a host that applies modes, and an agent with none', () => {
    expect(
      chatPermissionHostVerdict({
        agent: 'claude',
        hostAppliesModes: true,
        legacyMode: 'full-access',
        requested: 'ask'
      }).kind
    ).toBe('allowed')
    expect(
      chatPermissionHostVerdict({
        agent: 'grok',
        hostAppliesModes: false,
        legacyMode: null,
        requested: 'ask'
      }).kind
    ).toBe('allowed')
  })
})
