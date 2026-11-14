import { expect, it } from 'vitest'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import type { TitleDerivedPaneForeground } from './title-derived-pane-agent-identity'

it('discovers a hookless Prime native row without borrowing activity or sibling ownership', () => {
  const rowsFor = (title: string, foreground?: TitleDerivedPaneForeground) =>
    buildWorktreeAgentRows({
      tabs: [
        {
          id: 'tab',
          worktreeId: 'workspace',
          ptyId: 'pty',
          title,
          defaultTitle: 'Terminal',
          launchAgent: 'codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ],
      entries: [],
      retained: [],
      ptyIdsByTabId: { tab: ['pty', 'sibling-pty'] },
      terminalLayoutsByTabId: {
        tab: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
            second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
          },
          activeLeafId: '11111111-1111-4111-8111-111111111111',
          expandedLeafId: null
        }
      },
      runtimePaneTitlesByTabId: { tab: { 1: title, 2: 'Review Prime Agent integration' } },
      paneForegroundAgentByPaneKey: foreground
        ? { 'tab:11111111-1111-4111-8111-111111111111': foreground }
        : {},
      runtimeAgentOrchestrationByPaneKey: {
        'tab:11111111-1111-4111-8111-111111111111': {
          taskId: 'task-prime',
          dispatchId: 'dispatch-prime',
          parentPaneKey: 'coordinator:33333333-3333-4333-8333-333333333333'
        }
      },
      now: 1_000
    }).map((row) => ({
      paneKey: row.paneKey,
      agentType: row.agentType,
      state: row.state,
      orchestration: row.entry.orchestration
    }))

  const expected = [
    {
      paneKey: 'tab:11111111-1111-4111-8111-111111111111',
      agentType: 'prime-agent',
      state: 'idle',
      orchestration: {
        taskId: 'task-prime',
        dispatchId: 'dispatch-prime',
        parentPaneKey: 'coordinator:33333333-3333-4333-8333-333333333333'
      }
    }
  ]
  expect(rowsFor('prime-agent - workspace')).toEqual(expected)
  expect(rowsFor('Prime Agent')).toEqual(expected)
  expect(rowsFor('host | prime-agent - Review | Codex working')).toEqual(expected)
  expect(rowsFor('Review prime-agent - workspace')).toEqual([])
  expect(rowsFor('prime-agent - ')).toEqual([])
  expect(rowsFor('prime-agent working')).toEqual([])
  expect(rowsFor('Prime Agent', { agent: null, shellForeground: true })).toEqual([])
  expect(rowsFor('prime-agent - workspace', { agent: null, shellForeground: true })).toEqual([])
  expect(
    rowsFor('zsh', { agent: 'prime-agent', agentEvidence: 'process-read', shellForeground: false })
  ).toEqual([])
  expect(
    rowsFor('Terminal', {
      agent: 'prime-agent',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  ).toEqual([])
  expect(
    rowsFor('prime-agent - workspace', {
      agent: 'claude',
      agentEvidence: 'process-read',
      shellForeground: false
    })
  ).toEqual([{ ...expected[0], agentType: 'claude' }])
})
