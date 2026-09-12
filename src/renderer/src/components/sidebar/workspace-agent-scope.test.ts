import { describe, expect, it } from 'vitest'
import { getSidebarAgentVisibilityLabel } from './workspace-agent-scope'

const catalog = [
  { id: 'claude' as const, label: 'Claude' },
  { id: 'codex' as const, label: 'Codex' },
  { id: 'openclaude' as const, label: 'OpenClaude' }
]

describe('getSidebarAgentVisibilityLabel', () => {
  it('labels All, a single agent, and a multi-id scope', () => {
    expect(getSidebarAgentVisibilityLabel(null, catalog)).toBe('All agents')
    expect(getSidebarAgentVisibilityLabel(['codex'], catalog)).toBe('Codex')
    expect(getSidebarAgentVisibilityLabel(['claude', 'codex'], catalog)).toBe('2 agents')
    expect(getSidebarAgentVisibilityLabel(['claude', 'codex', 'openclaude'], catalog)).toBe(
      'All agents'
    )
  })
})
