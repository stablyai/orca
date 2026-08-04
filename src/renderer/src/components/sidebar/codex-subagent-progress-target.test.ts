import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import {
  createCodexSubagentProgressTarget,
  parseCodexSubagentProgressTarget
} from './codex-subagent-progress-target'

function childRow(provider = 'codex'): DashboardAgentRow {
  return {
    paneKey: 'parent\u0000subagent:child-1',
    tab: { id: 'tab-1' },
    agentType: 'reviewer',
    rowSource: 'subagent',
    state: 'working',
    startedAt: 10,
    entry: {
      prompt: 'Review files',
      model: 'gpt-5.4-mini',
      connectionId: null,
      orchestration: { taskId: 'child', dispatchId: 'child' }
    },
    subagentSession: { id: 'child-1', provider, parentPaneKey: 'parent-pane' }
  } as DashboardAgentRow
}

describe('Codex subagent progress target', () => {
  it('preserves explicit child identity and local host authority', () => {
    expect(
      createCodexSubagentProgressTarget(childRow(), 'folder:workspace-1', { kind: 'local' })
    ).toEqual({
      sessionId: 'child-1',
      startedAt: 10,
      paneKey: 'parent\u0000subagent:child-1',
      parentPaneKey: 'parent-pane',
      terminalTabId: 'tab-1',
      worktreeId: 'folder:workspace-1',
      label: 'Review files',
      model: 'gpt-5.4-mini',
      hostAuthority: { kind: 'local' }
    })
  })

  it('does not create a Codex target for another provider', () => {
    expect(
      createCodexSubagentProgressTarget(childRow('claude'), 'wt-1', { kind: 'local' })
    ).toBeNull()
  })

  it('rejects malformed modal data', () => {
    expect(parseCodexSubagentProgressTarget({ sessionId: 'child-1' })).toBeNull()
    expect(
      parseCodexSubagentProgressTarget({
        ...createCodexSubagentProgressTarget(childRow(), 'wt-1', { kind: 'local' }),
        startedAt: 0
      } as Record<string, unknown>)
    ).toBeNull()
  })

  it('retains captured runtime authority without consulting live workspace state', () => {
    const target = createCodexSubagentProgressTarget(childRow(), 'wt-1', {
      kind: 'runtime',
      environmentId: 'env-1'
    })

    expect(parseCodexSubagentProgressTarget(target as Record<string, unknown>)).toMatchObject({
      hostAuthority: { kind: 'runtime', environmentId: 'env-1' }
    })
  })
})
