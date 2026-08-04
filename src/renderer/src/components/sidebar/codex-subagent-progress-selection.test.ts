import { describe, expect, it } from 'vitest'
import { resolveCodexSubagentProgressPaneKey } from './codex-subagent-progress-selection'

const target = {
  sessionId: 'child-1',
  startedAt: 10,
  paneKey: 'parent\u0000subagent:child-1',
  parentPaneKey: 'parent',
  terminalTabId: 'tab-1',
  worktreeId: 'wt-1',
  label: '/root/test_agent',
  hostAuthority: { kind: 'local' }
}

describe('resolveCodexSubagentProgressPaneKey', () => {
  it('selects only the inspected child in its worktree', () => {
    expect(resolveCodexSubagentProgressPaneKey('codex-subagent-progress', target, 'wt-1')).toBe(
      'parent\u0000subagent:child-1'
    )
    expect(
      resolveCodexSubagentProgressPaneKey('codex-subagent-progress', target, 'wt-2')
    ).toBeNull()
    expect(resolveCodexSubagentProgressPaneKey('none', target, 'wt-1')).toBeNull()
  })
})
