import { beforeEach, describe, expect, it, vi } from 'vitest'

const LEAF = '11111111-1111-4111-8111-111111111111'
const applyTerminalChatPair = vi.fn()
const createTab = vi.fn(
  (_worktreeId: string, _group?: string, _type?: string, options?: { id?: string }) => ({
    id: options?.id ?? 'tab-minted'
  })
)
type UnifiedStub = { entityId: string; contentType: string; viewMode?: string }
const initialTabs: Record<string, { id: string; title?: string }[]> = {}
const initialUnified: Record<string, UnifiedStub[]> = {}
const initialLayouts: Record<string, unknown> = {}
const state = {
  tabsByWorktree: initialTabs,
  unifiedTabsByWorktree: initialUnified,
  terminalLayoutsByTabId: initialLayouts,
  settings: { experimentalNativeChat: true, openAgentTabsInChatByDefault: true },
  createTab,
  applyTerminalChatPair,
  setTabLayout: vi.fn((tabId: string, layout: unknown) => {
    state.terminalLayoutsByTabId[tabId] = layout
  }),
  updateTabPtyId: vi.fn(),
  clearAgentLaunchConfig: vi.fn(),
  registerAgentLaunchConfig: vi.fn(),
  revealWorktreeInSidebar: vi.fn(),
  setTabCustomTitle: vi.fn()
}
let ownedTabId: string | null = null
let createTerminal: ((data: Record<string, unknown>) => void) | null = null

vi.mock('../../store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/terminal-tab-for-pty-id', () => ({
  resolveTerminalTabPtyOwnership: () =>
    ownedTabId ? { kind: 'owned', tabId: ownedTabId } : { kind: 'none' }
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  hasRegisteredRuntimeTerminalTab: () => false,
  focusRuntimeTerminalSurface: () => false
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

beforeEach(async () => {
  vi.clearAllMocks()
  ownedTabId = null
  state.tabsByWorktree = { wt: [] }
  state.unifiedTabsByWorktree = { wt: [] }
  state.terminalLayoutsByTabId = {}
  vi.stubGlobal('window', {
    api: {
      ui: {
        onCreateTerminal: (listener: typeof createTerminal) => {
          createTerminal = listener
          return () => {}
        },
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate: vi.fn()
      }
    },
    dispatchEvent: vi.fn()
  })
  const { registerTerminalPresentationIpcBridge } =
    await import('./terminal-presentation-ipc-bridge')
  registerTerminalPresentationIpcBridge([])
})

function reuseTab(viewMode?: 'terminal' | 'chat'): void {
  ownedTabId = 'tab-reused'
  state.tabsByWorktree.wt = [{ id: 'tab-reused' }]
  state.unifiedTabsByWorktree.wt = [
    { entityId: 'tab-reused', contentType: 'terminal', ...(viewMode ? { viewMode } : {}) }
  ]
}

const reveal = {
  worktreeId: 'wt',
  ptyId: 'pty-1',
  tabId: 'tab-reused',
  leafId: LEAF,
  launchAgent: 'claude',
  presentation: 'background'
}

describe('a host reveal of an agent launch', () => {
  it('mints exactly the view main committed, never a renderer default', () => {
    createTerminal!({ ...reveal, tabId: undefined })
    expect(createTab.mock.calls[0]?.[3]).not.toHaveProperty('viewMode')
  })

  it('fills in a fresh launch view on a reused tab that has none (STA-9293 reuse)', () => {
    reuseTab()
    createTerminal!({ ...reveal, viewMode: 'chat', freshLaunchView: true })
    expect(createTab).not.toHaveBeenCalled()
    expect(applyTerminalChatPair).toHaveBeenCalledWith('tab-reused', LEAF, 'chat')
  })

  it('never replaces a reused tab that already has a view', () => {
    reuseTab('terminal')
    createTerminal!({ ...reveal, viewMode: 'chat', freshLaunchView: true })
    expect(applyTerminalChatPair).not.toHaveBeenCalled()
  })

  it('never fills in without proof that this launch created the record', () => {
    reuseTab()
    createTerminal!({ ...reveal, viewMode: 'chat' })
    expect(applyTerminalChatPair).not.toHaveBeenCalled()
  })
})
