import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'

const tab: TerminalTab = {
  id: 'parent-tab',
  ptyId: null,
  worktreeId: 'folder-workspace',
  title: 'Parent',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

describe('shared CLI and structured child freshness', () => {
  it.each([
    ['working', true, undefined, 'working'],
    ['working', true, 'live', 'working'],
    ['working', false, undefined, 'unverifiable'],
    ['working', false, 'live', 'unverifiable'],
    ['working', true, 'unverifiable', 'unverifiable'],
    ['working', false, 'unverifiable', 'unverifiable'],
    ['waiting', false, undefined, 'unverifiable'],
    ['waiting', false, 'live', 'unverifiable'],
    ['blocked', false, undefined, 'unverifiable'],
    ['blocked', false, 'live', 'unverifiable'],
    ['idle', false, undefined, 'idle'],
    ['idle', false, 'live', 'idle'],
    ['idle', false, 'unverifiable', 'idle'],
    ['unverifiable', true, 'live', 'unverifiable']
  ] as const)(
    '%s with fresh parent %s and transport %s projects %s',
    (state, parentIsFresh, subagentObservation, expected) => {
      const parentEntry: AgentStatusEntry = {
        paneKey: 'parent-pane',
        tabId: tab.id,
        worktreeId: tab.worktreeId,
        state: 'working',
        prompt: 'parent prompt',
        updatedAt: 100,
        stateStartedAt: 10,
        stateHistory: [],
        subagentObservation,
        subagents: [{ id: 'child', state, startedAt: 20 }]
      }
      const row = buildSubagentChildRows({ parentEntry, tab, parentIsFresh })[0]
      expect(row.state).toBe(expected)
      expect(row.activationPaneKey).toBe(parentEntry.paneKey)
      expect(row.startedAt).toBe(20)
      expect(parentEntry.subagents).toEqual([{ id: 'child', state, startedAt: 20 }])
    }
  )
})
