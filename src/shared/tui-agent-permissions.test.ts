import { describe, expect, it } from 'vitest'
import {
  agentHasPermissionMode,
  normalizeAgentPermissionModeOverrides,
  resolveAgentPermissionMode,
  resolveDefaultAgentPermissionMode,
  type AgentPermissionSettingsFields
} from './tui-agent-permissions'

describe('tui agent permissions', () => {
  it('defaults an untouched profile to bypass, as Orca has always shipped', () => {
    expect(resolveDefaultAgentPermissionMode({})).toBe('bypass')
    expect(resolveAgentPermissionMode('claude', undefined)).toBe('bypass')
  })

  it('prefers the agent override over the shared default', () => {
    const settings = {
      agentPermissionMode: 'ask' as const,
      agentPermissionModeOverrides: { codex: 'bypass' as const }
    }
    expect(resolveAgentPermissionMode('codex', settings)).toBe('bypass')
    expect(resolveAgentPermissionMode('claude', settings)).toBe('ask')
  })

  // A mode a newer build wrote stays stored for it.
  it('drops unknown agents but keeps every stored mode', () => {
    expect(
      normalizeAgentPermissionModeOverrides({
        claude: 'ask',
        nope: 'bypass',
        codex: 'yolo',
        gemini: 1
      })
    ).toEqual({ claude: 'ask', codex: 'yolo' })
    expect(normalizeAgentPermissionModeOverrides('bad')).toEqual({})
  })

  it('knows which agents have a permission mode at all', () => {
    expect(agentHasPermissionMode('claude')).toBe(true)
    expect(agentHasPermissionMode('goose')).toBe(true)
    expect(agentHasPermissionMode('opencode')).toBe(false)
  })

  // A newer build may store a mode this one doesn't know; it fails toward more prompts.
  it('reads a stored mode it does not know as ask', () => {
    const settings: AgentPermissionSettingsFields = JSON.parse(
      '{"agentPermissionMode":"accept-edits"}'
    )
    expect(resolveDefaultAgentPermissionMode(settings)).toBe('ask')
    expect(resolveAgentPermissionMode('claude', settings)).toBe('ask')
    expect(
      resolveAgentPermissionMode('codex', {
        ...settings,
        agentPermissionModeOverrides: { codex: 'bypass' }
      })
    ).toBe('bypass')
    expect(
      resolveAgentPermissionMode('codex', {
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: { codex: 'accept-edits' }
      })
    ).toBe('ask')
  })
})
