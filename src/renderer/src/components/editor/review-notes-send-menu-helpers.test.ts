import { describe, expect, it } from 'vitest'
import {
  getTerminalIndexForTab,
  formatTimeAgo,
  orderSendTargetsByWorktreeAgentRows
} from './review-notes-send-menu-helpers'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { NotesSendAgentTarget } from '@/lib/notes-send-agent-targets'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'

function createMockTab(id: string, color: string | null = null): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: id,
    customTitle: null,
    color,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('review-notes-send-menu-helpers', () => {
  describe('getTerminalIndexForTab', () => {
    it('returns 1-based index and color for matching tab', () => {
      const tabs: TerminalTab[] = [
        createMockTab('tab-1', null),
        createMockTab('tab-2', '#ef4444'),
        createMockTab('tab-3', '#3b82f6')
      ]

      expect(getTerminalIndexForTab(tabs, 'tab-1')).toEqual({
        terminalIndex: 1,
        tabColor: null
      })
      expect(getTerminalIndexForTab(tabs, 'tab-2')).toEqual({
        terminalIndex: 2,
        tabColor: '#ef4444'
      })
      expect(getTerminalIndexForTab(tabs, 'tab-3')).toEqual({
        terminalIndex: 3,
        tabColor: '#3b82f6'
      })
    })

    it('returns undefined terminalIndex when tab is not found', () => {
      const tabs: TerminalTab[] = [createMockTab('tab-1')]
      expect(getTerminalIndexForTab(tabs, 'unknown')).toEqual({
        terminalIndex: undefined,
        tabColor: null
      })
    })

    it('returns undefined terminalIndex when tabs list is undefined', () => {
      expect(getTerminalIndexForTab(undefined, 'tab-1')).toEqual({
        terminalIndex: undefined,
        tabColor: null
      })
    })
  })

  describe('formatTimeAgo', () => {
    it('formats intervals correctly', () => {
      const now = 1_000_000
      expect(formatTimeAgo(now - 10_000, now)).toBe('just now')
      expect(formatTimeAgo(now - 60_000, now)).toBe('1m ago')
      expect(formatTimeAgo(now - 120_000, now)).toBe('2m ago')
      expect(formatTimeAgo(now - 3_600_000, now)).toBe('1h ago')
      expect(formatTimeAgo(now - 86_400_000, now)).toBe('1d ago')
    })
  })

  describe('orderSendTargetsByWorktreeAgentRows', () => {
    it('orders targets by agentRows priority', () => {
      const targets: NotesSendAgentTarget[] = [
        {
          paneKey: 'pane-a',
          tabId: 'tab-a',
          leafId: 'leaf-a',
          agentType: 'claude',
          tabTitle: 'Tab A',
          status: 'eligible'
        },
        {
          paneKey: 'pane-b',
          tabId: 'tab-b',
          leafId: 'leaf-b',
          agentType: 'codex',
          tabTitle: 'Tab B',
          status: 'eligible'
        }
      ]

      const agentRows = [
        {
          paneKey: 'pane-b',
          agentType: 'codex'
        } as DashboardAgentRowData
      ]

      const ordered = orderSendTargetsByWorktreeAgentRows(targets, agentRows)
      expect(ordered).toHaveLength(2)
      expect(ordered[0].target.paneKey).toBe('pane-b')
      expect(ordered[1].target.paneKey).toBe('pane-a')
    })
  })
})
