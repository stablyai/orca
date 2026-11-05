// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'

const mocks = vi.hoisted(() => {
  const unifiedTabsByWorktree: Record<string, unknown[]> = {}
  const terminalLayoutsByTabId: Record<string, unknown> = {}
  const tabsByWorktree: Record<string, unknown[]> = {}
  return {
    state: {
      unifiedTabsByWorktree,
      terminalLayoutsByTabId,
      tabsByWorktree,
      setTabCustomTitle: vi.fn(),
      dropAgentStatus: vi.fn(),
      dismissRetainedAgent: vi.fn()
    },
    renamePane: vi.fn(),
    closeTab: vi.fn(),
    closeLegacyTab: vi.fn(),
    closePane: vi.fn(async () => true)
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand: mocks.closeTab }))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeLegacyTab
}))
vi.mock('./sidebar-agent-pane-close', () => ({ closeSidebarAgentPane: mocks.closePane }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/hooks/ipc-events/terminal-pane-title-ipc-bridge', () => ({
  applyRuntimePaneTitle: mocks.renamePane
}))
import { closeSidebarAgent } from './sidebar-agent-close'
import { renameSidebarAgent } from './sidebar-agent-rename'

const row: DashboardAgentRow = {
  paneKey: 'agent-b:11111111-1111-4111-8111-111111111111',
  tab: {
    id: 'agent-b',
    worktreeId: 'workspace-b',
    ptyId: null,
    title: 'Agent B',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  },
  agentType: 'codex',
  state: 'done',
  startedAt: 1,
  entry: {
    paneKey: 'agent-b:11111111-1111-4111-8111-111111111111',
    tabId: 'agent-b',
    worktreeId: 'workspace-b',
    agentType: 'codex',
    prompt: 'Review API',
    state: 'done',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  },
  rowSource: 'live'
}

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
  mocks.state.terminalLayoutsByTabId = {
    'agent-b': {
      root: {
        type: 'split',
        first: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
        second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
      }
    }
  }
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

it('renames the selected split leaf without renaming its sibling tab', () => {
  mocks.state.terminalLayoutsByTabId = {
    'agent-b': {
      root: {
        type: 'split',
        first: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
        second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
      }
    }
  }
  expect(renameSidebarAgent(row, '  Review API  ')).toBe(true)
  expect(mocks.renamePane).toHaveBeenCalledWith({
    tabId: 'agent-b',
    leafId: '11111111-1111-4111-8111-111111111111',
    title: 'Review API'
  })
  expect(mocks.state.setTabCustomTitle).not.toHaveBeenCalled()
})

it('renames a chat through its unified tab rather than its session identity', () => {
  mocks.state.unifiedTabsByWorktree = {
    'workspace-b': [{ id: 'agent-b', entityId: 'session-b', contentType: 'agent-session' }]
  }
  expect(renameSidebarAgent(row, 'Review API')).toBe(true)
  expect(mocks.state.setTabCustomTitle).toHaveBeenCalledWith('agent-b', 'Review API')
})

it('does not rename a vanished agent or a synthetic child', () => {
  mocks.state.unifiedTabsByWorktree = {}
  expect(renameSidebarAgent(row, 'Wrong target')).toBe(false)
  expect(renameSidebarAgent({ ...row, rowSource: 'subagent' }, 'Wrong target')).toBe(false)
  expect(mocks.state.setTabCustomTitle).not.toHaveBeenCalled()
  expect(mocks.renamePane).not.toHaveBeenCalled()
})
