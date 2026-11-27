import { describe, expect, it } from 'vitest'
import type {
  AgentChildWorkInput,
  AgentChildWorkKind,
  AgentChildWorkResidency
} from './agent-status-child-work'
import { makeStructuredAgentStatusSubject } from '../contracts/agent-status-subject'
import { projectAgentChildWorkViews } from './agent-status-child-work-view'

const parent = makeStructuredAgentStatusSubject(
  { executionHostId: 'local', wslDistro: null, workspaceId: '/folder', workspaceKind: 'folder' },
  'session-1'
)

function record(
  id: string,
  provider: string,
  kind: AgentChildWorkKind,
  residency?: AgentChildWorkResidency
): AgentChildWorkInput {
  return {
    childWorkId: id,
    parent,
    provider,
    kind,
    state: 'working',
    membership: 'live',
    ...(residency ? { residency } : {}),
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: residency === 'background',
    invocation: { invocationId: `${id}-run`, generation: 1 },
    provenance: { source: 'structured-session', producerId: 'test' }
  }
}

function visibleIds(records: AgentChildWorkInput[]): string[] {
  return projectAgentChildWorkViews(records, []).map((view) => view.id)
}

describe('projectAgentChildWorkViews foreground commands', () => {
  it('keeps every provider’s foreground command out of the views', () => {
    expect(
      visibleIds([
        record('claude-fg', 'claude', 'command', 'foreground'),
        record('codex-fg', 'codex', 'command', 'foreground')
      ])
    ).toEqual([])
  })

  it('keeps background commands, foreground agents and records without residency', () => {
    expect(
      visibleIds([
        record('claude-bg', 'claude', 'command', 'background'),
        record('codex-bg', 'codex', 'command', 'background'),
        record('claude-agent-fg', 'claude', 'agent', 'foreground'),
        record('claude-monitor', 'claude', 'monitor', 'background'),
        record('hook-command', 'claude', 'command')
      ])
    ).toEqual(['claude-bg', 'codex-bg', 'claude-agent-fg', 'claude-monitor', 'hook-command'])
  })

  it('shows a command once it moves to the background', () => {
    const running = record('claude-cmd', 'claude', 'command', 'foreground')
    expect(visibleIds([running])).toEqual([])
    expect(visibleIds([{ ...running, residency: 'background', stoppable: true }])).toEqual([
      'claude-cmd'
    ])
  })
})
