import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  cancelStructuredAgentLaunch: vi.fn(),
  closeBrowserTab: vi.fn(),
  closeFile: vi.fn(),
  closeStructuredAgentSession: vi.fn(),
  closeTerminalTab: vi.fn(),
  closeUnifiedTab: vi.fn(),
  clearNativeChatLaunchDraft: vi.fn(),
  setActiveWorktree: vi.fn(),
  toastError: vi.fn()
}))

const store = vi.hoisted(() => ({
  activeWorktreeId: 'wt-1',
  browserPagesByWorkspace: {},
  browserTabsByWorktree: {},
  closeBrowserTab: mocks.closeBrowserTab,
  closeFile: mocks.closeFile,
  closeUnifiedTab: mocks.closeUnifiedTab,
  clearNativeChatLaunchDraft: mocks.clearNativeChatLaunchDraft,
  openFiles: [],
  reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
  setActiveWorktree: mocks.setActiveWorktree,
  tabsByWorktree: {},
  unifiedTabsByWorktree: {} as Record<string, unknown[]>
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react')
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useMemo: <T>(factory: () => T) => factory()
  }
})

vi.mock('../../store', () => ({
  useAppStore: Object.assign((selector: (state: typeof store) => unknown) => selector(store), {
    getState: () => store
  })
}))

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))

vi.mock('../editor/editor-autosave', () => ({
  requestEditorFileClose: vi.fn()
}))

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeTerminalTab
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/runtime/remote-browser-tab-ownership', () => ({
  browserWorkspaceHasRemoteOwner: () => false
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  cancelStructuredAgentLaunch: mocks.cancelStructuredAgentLaunch
}))

vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'

const AGENT_TAB = {
  id: 'agent-tab-1',
  entityId: 'session-1',
  groupId: 'group-1',
  worktreeId: 'wt-1',
  contentType: 'agent-session' as const,
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

beforeEach(() => {
  vi.clearAllMocks()
  store.unifiedTabsByWorktree = { 'wt-1': [AGENT_TAB] }
  mocks.closeStructuredAgentSession.mockResolvedValue('closed')
  mocks.callRuntimeRpc.mockResolvedValue({ ok: true })
})

describe('structured agent-session close ordering', () => {
  it('removes the local tab synchronously while host retirement runs independently', async () => {
    const { closeItem } = useTabGroupTabCloseCommands({
      worktreeId: 'wt-1',
      groupTabs: [AGENT_TAB]
    })
    closeItem(AGENT_TAB.id)

    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith(AGENT_TAB.id)
  })

  it('returns immediately for an unadopted launch tab', async () => {
    const { closeItem } = useTabGroupTabCloseCommands({
      worktreeId: 'wt-1',
      groupTabs: [AGENT_TAB]
    })
    closeItem(AGENT_TAB.id)

    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith(AGENT_TAB.id)
  })

  it('closes reconciling launches through the same synchronous path during bulk close', async () => {
    const { closeMany } = useTabGroupTabCloseCommands({
      worktreeId: 'wt-1',
      groupTabs: [AGENT_TAB]
    })

    closeMany([AGENT_TAB.id])

    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith(AGENT_TAB.id)
  })
})
