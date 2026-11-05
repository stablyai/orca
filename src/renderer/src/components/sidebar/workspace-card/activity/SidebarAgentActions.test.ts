// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'

const mocks = vi.hoisted(() => ({
  state: {
    unifiedTabsByWorktree: {} as Record<string, unknown[]>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    tabsByWorktree: {} as Record<string, unknown[]>,
    dropAgentStatus: vi.fn(),
    dismissRetainedAgent: vi.fn()
  },
  closeTab: vi.fn(),
  closeLegacyTab: vi.fn(),
  closePane: vi.fn(async () => true)
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand: mocks.closeTab }))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeLegacyTab
}))
vi.mock('./sidebar-agent-pane-close', () => ({ closeSidebarAgentPane: mocks.closePane }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { closeSidebarAgent } from './SidebarAgentActions'

const row = {
  paneKey: 'agent-b:11111111-1111-4111-8111-111111111111',
  tab: { id: 'agent-b', worktreeId: 'workspace-b' },
  rowSource: 'live'
} as DashboardAgentRow

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.unifiedTabsByWorktree = {
    'workspace-b': [
      { id: 'unified-a', entityId: 'agent-a', contentType: 'terminal' },
      { id: 'unified-b', entityId: 'agent-b', contentType: 'terminal' }
    ]
  }
  mocks.state.terminalLayoutsByTabId = {}
})

it('closes the selected sidebar agent through the guarded tab command', () => {
  closeSidebarAgent(row)
  expect(mocks.closeTab).toHaveBeenCalledWith({
    type: 'close',
    target: {
      kind: 'tab',
      worktreeId: 'workspace-b',
      tabId: 'unified-b'
    }
  })
})

it('closes the selected split leaf rather than the whole tab', () => {
  mocks.state.terminalLayoutsByTabId = { 'agent-b': { root: { type: 'split' } } }
  closeSidebarAgent(row)
  expect(mocks.closePane).toHaveBeenCalledWith(
    'workspace-b',
    'agent-b',
    '11111111-1111-4111-8111-111111111111'
  )
  expect(mocks.closeTab).not.toHaveBeenCalled()
})

it('cannot close a parent when handed a synthetic subagent row', () => {
  closeSidebarAgent({ ...row, rowSource: 'subagent' })
  expect(mocks.closeTab).not.toHaveBeenCalled()
  expect(mocks.closePane).not.toHaveBeenCalled()
  expect(mocks.state.dropAgentStatus).not.toHaveBeenCalled()
})
