import { describe, expect, it } from 'vitest'
import {
  createCustomAgentId,
  isCustomAgentId,
  normalizeAgentIds,
  normalizeCustomAgents
} from './custom-agent'

describe('custom agents', () => {
  it('creates stable readable ids without collisions', () => {
    expect(createCustomAgentId('My Agent')).toBe('custom:my-agent')
    expect(createCustomAgentId('My Agent', ['custom:my-agent'])).toBe('custom:my-agent-2')
  })

  it('normalizes valid definitions and drops malformed entries', () => {
    expect(
      normalizeCustomAgents([
        {
          id: 'custom:forge',
          name: ' Forge ',
          command: 'forge --tui',
          promptMode: 'template',
          promptTemplate: 'forge --prompt {prompt}',
          icon: { kind: 'terminal' },
          enabled: true
        },
        { id: 'custom:broken', name: '', command: 'x' }
      ])
    ).toEqual([
      {
        id: 'custom:forge',
        name: 'Forge',
        command: 'forge --tui',
        promptMode: 'template',
        promptTemplate: 'forge --prompt {prompt}',
        icon: { kind: 'terminal' },
        enabled: true
      }
    ])
  })

  it('accepts native and custom ids while filtering unknown values', () => {
    expect(isCustomAgentId('custom:forge')).toBe(true)
    expect(normalizeAgentIds(['codex', 'custom:forge', 'custom:forge', 'unknown', null])).toEqual([
      'codex',
      'custom:forge'
    ])
  })
})
