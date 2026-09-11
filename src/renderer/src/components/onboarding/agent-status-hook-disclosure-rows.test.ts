import { describe, expect, it } from 'vitest'
import { AGENT_HOOK_TARGETS } from '../../../../shared/agent-hook-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildAgentStatusHookAffectedRows } from './agent-status-hook-disclosure-rows'

describe('buildAgentStatusHookAffectedRows', () => {
  it('returns nothing when no agents were detected', () => {
    expect(
      buildAgentStatusHookAffectedRows({ detectedAgentIds: [], disabledTuiAgents: [] })
    ).toEqual([])
  })

  it('names both Codex lanes, because the real-home one writes the user\u2019s own files', () => {
    const rows = buildAgentStatusHookAffectedRows({
      detectedAgentIds: ['codex'],
      disabledTuiAgents: []
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].agent).toBe('codex')
    expect(rows[0].location).toContain('~/.codex/hooks.json')
    expect(rows[0].location).toContain('config.toml')
    expect(rows[0].location).toContain('Orca-managed Codex home')
  })

  it('keeps only detected, enabled hook targets', () => {
    // `aider` is detected but is not a hook target; `cursor` is a target the user disabled.
    const rows = buildAgentStatusHookAffectedRows({
      detectedAgentIds: ['claude', 'cursor', 'aider'] as TuiAgent[],
      disabledTuiAgents: ['cursor']
    })

    expect(rows.map((row) => row.agent)).toEqual(['claude'])
    expect(rows[0].name).toBe('Claude')
    expect(rows[0].location).toBe('~/.claude/settings.json')
  })

  it('orders rows by the stable hook-target list, not detection order', () => {
    const rows = buildAgentStatusHookAffectedRows({
      detectedAgentIds: ['cursor', 'claude', 'gemini'],
      disabledTuiAgents: []
    })
    const expected = AGENT_HOOK_TARGETS.filter((agent) =>
      ['cursor', 'claude', 'gemini'].includes(agent)
    )

    expect(rows.map((row) => row.agent)).toEqual([...expected])
  })
})
