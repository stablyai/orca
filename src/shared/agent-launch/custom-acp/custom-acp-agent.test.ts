import { describe, expect, it } from 'vitest'
import { createCustomAcpAgentId, normalizeCustomAcpAgents } from './custom-acp-agent'

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
