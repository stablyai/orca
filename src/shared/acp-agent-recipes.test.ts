import { describe, expect, it } from 'vitest'

import {
  acpAccountHomeVariable,
  acpHandleProvider,
  acpSpawnRecipe,
  isAcpStructuredAgent
} from './acp-agent-recipes'

describe('ACP spawn recipes', () => {
  it('names the four Chat UI agents and no others', () => {
    expect(isAcpStructuredAgent('grok')).toBe(true)
    expect(isAcpStructuredAgent('cursor')).toBe(true)
    expect(isAcpStructuredAgent('claude')).toBe(true)
    expect(isAcpStructuredAgent('openclaude')).toBe(true)
    expect(isAcpStructuredAgent('codex')).toBe(true)
    expect(isAcpStructuredAgent('omp')).toBe(false)
    expect(isAcpStructuredAgent('gemini')).toBe(false)
  })

  it('spawns first-party ACP for Grok and Cursor', () => {
    expect(acpSpawnRecipe('grok')).toEqual({ program: 'grok', args: ['agent', 'stdio'] })
    expect(acpSpawnRecipe('cursor')).toEqual({ program: 'agent', args: ['acp'] })
  })

  it('spawns the official ACP adapters for Claude and Codex', () => {
    expect(acpSpawnRecipe('claude')).toEqual({
      program: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp']
    })
    expect(acpSpawnRecipe('openclaude')).toEqual(acpSpawnRecipe('claude'))
    expect(acpSpawnRecipe('codex')).toEqual({
      program: 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp']
    })
  })

  it('returns null for an agent this Chat UI slice does not speak ACP for', () => {
    expect(acpSpawnRecipe('omp')).toBeNull()
  })

  it('maps OpenClaude onto the Claude handle and account home', () => {
    expect(acpHandleProvider('openclaude')).toBe('claude')
    expect(acpAccountHomeVariable('openclaude')).toBe('CLAUDE_CONFIG_DIR')
    expect(acpAccountHomeVariable('grok')).toBe('GROK_HOME')
    expect(acpAccountHomeVariable('cursor')).toBe('CURSOR_CONFIG_DIR')
  })
})
