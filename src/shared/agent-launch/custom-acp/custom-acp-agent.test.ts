import { describe, expect, it } from 'vitest'
import {
  createCustomAcpAgentId,
  customAcpNewChatPermission,
  normalizeCustomAcpAgents,
  savedCustomAcpDefaultAgent,
  type CustomAcpAgent,
  type CustomAcpAgentId
} from './custom-acp-agent'

describe('normalizeCustomAcpAgents', () => {
  it('keeps valid rows and drops malformed, duplicate or unsafe ones individually', () => {
    const agents = normalizeCustomAcpAgents([
      { id: 'custom-acp-a1', name: ' Mine ', command: ' my-agent ', args: ['acp', '--x y'] },
      { id: 'custom-acp-a1', name: 'Duplicate', command: 'other' },
      { id: 'claude', name: 'Shadows a built-in', command: 'claude' },
      { id: 'custom-acp-b2', name: '', command: 'blank-name' },
      { id: 'custom-acp-c3', name: 'Bad env', command: 'x', env: { 'BAD NAME': '1' } },
      { id: 'custom-acp-d4', name: 'Env', command: '/opt/agent', env: { API_KEY: 'k' } },
      { id: 'custom-acp-e5', name: 'Off', command: 'off', disabled: true },
      { id: 'custom-acp-f6', name: 'Bad flag', command: 'on', disabled: 'yes' },
      'not an object'
    ])
    expect(agents).toEqual([
      { id: 'custom-acp-a1', name: 'Mine', command: 'my-agent', args: ['acp', '--x y'], env: {} },
      { id: 'custom-acp-d4', name: 'Env', command: '/opt/agent', args: [], env: { API_KEY: 'k' } },
      { id: 'custom-acp-e5', name: 'Off', command: 'off', args: [], env: {}, disabled: true },
      { id: 'custom-acp-f6', name: 'Bad flag', command: 'on', args: [], env: {} }
    ])
  })

  it('reads anything but a list as no agents', () => {
    expect(normalizeCustomAcpAgents(undefined)).toEqual([])
    expect(normalizeCustomAcpAgents({ id: 'custom-acp-a1' })).toEqual([])
  })

  it('mints ids that are valid structured agent slugs', () => {
    expect(createCustomAcpAgentId(() => 'AB-12_cd/34')).toBe('custom-acp-ab12cd34')
    expect(createCustomAcpAgentId(() => '')).toBe('custom-acp-0')
  })
})

describe('savedCustomAcpDefaultAgent', () => {
  const agents: CustomAcpAgent[] = [
    { id: 'custom-acp-on', name: 'On', command: 'on', args: [], env: {} },
    { id: 'custom-acp-off', name: 'Off', command: 'off', args: [], env: {}, disabled: true }
  ]

  it('applies only to a defined, switched-on agent while no built-in default is saved', () => {
    const pick = (defaultCustomAcpAgent: CustomAcpAgentId, defaultTuiAgent: unknown = null) =>
      savedCustomAcpDefaultAgent({
        customAcpAgents: agents,
        defaultCustomAcpAgent,
        defaultTuiAgent
      })?.id ?? null
    expect(pick('custom-acp-on')).toBe('custom-acp-on')
    expect(pick('custom-acp-on', 'codex')).toBeNull()
    expect(pick('custom-acp-on', 'blank')).toBeNull()
    expect(pick('custom-acp-off')).toBeNull()
    expect(pick('custom-acp-gone')).toBeNull()
  })
})

describe('customAcpNewChatPermission', () => {
  it('starts new chats with full access unless the agent asks, and a malformed value asks', () => {
    const row = (newChatPermission?: unknown) => ({
      customAcpAgents: [
        { id: 'custom-acp-x', name: 'X', command: 'x', args: [], env: {}, newChatPermission }
      ]
    })
    expect(customAcpNewChatPermission(row(), 'custom-acp-x')).toBe('full-access')
    expect(customAcpNewChatPermission(row('ask'), 'custom-acp-x')).toBe('ask')
    expect(customAcpNewChatPermission(row('yolo'), 'custom-acp-x')).toBe('ask')
  })
})
