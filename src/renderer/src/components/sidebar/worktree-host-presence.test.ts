import { collectTabPaneInputs, resolveAttention } from './smart-attention'
import { describe, expect, it } from 'vitest'
import { makeTab } from '@/store/slices/store-test-helpers'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { getWorktreeStatus } from '@/lib/worktree-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { resolveTerminalTabActivityStatus } from '../tab-bar/terminal-tab-activity-status'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `tab-1:${leafId}`
const claude = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:123' }
} as const
const presenceOf = (ended: boolean) => ({
  [paneKey]: { presence: ended ? { ...claude, ended: true as const } : claude, receivedAt: 20 }
})
const terminalLayoutsByTabId = {
  'tab-1': { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
} as const
const ptyIdsByTabId = { 'tab-1': ['pty-1'] }
const tabTitled = (title: string, launchAgent: 'claude' | undefined = 'claude') =>
  makeTab({ id: 'tab-1', worktreeId: 'folder-1', title, launchAgent })

function rows(title: string, ended: boolean, foregroundAgent?: 'codex') {
  return buildWorktreeAgentRows({
    tabs: [tabTitled(title)],
    entries: [],
    retained: [],
    agentPresenceByPaneKey: presenceOf(ended),
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    ...(foregroundAgent
      ? {
          paneForegroundAgentByPaneKey: {
            [paneKey]: {
              agent: foregroundAgent,
              agentEvidence: 'process-read' as const,
              shellForeground: false
            }
          }
        }
      : {}),
    now: Date.now()
  }).map((row) => [row.agentType, row.state])
}

function attentionClass(title: string, ended: boolean): number {
  const tab = tabTitled(title)
  const inputs = collectTabPaneInputs(
    tab,
    Date.now(),
    {
      entriesByTabId: new Map(),
      agentPresenceByPaneKey: presenceOf(ended),
      ptyIdsByTabId,
      runtimePaneTitlesByTabId: {},
      terminalLayoutsByTabId
    },
    Date.now()
  )
  return resolveAttention(inputs, Date.now()).cls
}

describe('workspace host exit publication', () => {
  it('drops the exited owner title row without a shell prompt', () => {
    expect(rows('⠋ Claude Code', true)).toEqual([])
  })

  it('stops the workspace activity signal while the exited owner title remains', () => {
    const status = (ended: boolean) =>
      getWorktreeStatus(
        [tabTitled('⠋ Claude Code')],
        [],
        ptyIdsByTabId,
        {},
        {
          terminalLayoutsByTabId,
          agentPresenceByPaneKey: presenceOf(ended)
        }
      )
    expect(status(false)).toBe('working')
    expect(status(true)).toBe('active')
  })

  it('removes the exited owner from smart attention despite its stale spinner title', () => {
    expect(attentionClass('⠋ Claude Code', true)).toBe(5)
  })

  it('still shows a later agent in a pane whose identified owner exited', () => {
    expect(rows('⠋ Codex', true)).toEqual([['codex', 'working']])
    expect(rows('orca', true, 'codex')).toEqual([['codex', 'idle']])
    expect(attentionClass('⠋ Codex', true)).toBe(attentionClass('⠋ Codex', false))
  })

  it('lets a live owner whose hook went quiet still read working from its title', () => {
    const stale: AgentStatusEntry = {
      paneKey,
      agentType: 'claude',
      state: 'working',
      prompt: 'work',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: []
    }
    expect(
      resolveTerminalTabActivityStatus({
        tab: tabTitled('⠋ Claude Code'),
        agentStatusByPaneKey: { [paneKey]: stale },
        agentStatusEpoch: 1,
        ptyIdsByTabId,
        terminalLayout: terminalLayoutsByTabId['tab-1'],
        agentPresenceByPaneKey: presenceOf(false)
      })
    ).toBe('working')
  })
})
