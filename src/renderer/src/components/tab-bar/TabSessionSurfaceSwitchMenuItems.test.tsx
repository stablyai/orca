// @vitest-environment happy-dom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TabSessionSurfaceSwitchMenuItems } from './TabSessionSurfaceSwitchMenuItems'

const mocks = vi.hoisted(() => {
  const state: {
    subject: Record<string, unknown> | null
    cliSource: Record<string, unknown> | null
  } = { subject: null, cliSource: null }
  return {
    ...state,
    pending: false,
    sideChatSource: false,
    openSideChat: vi.fn(async () => true),
    pendingListeners: new Set<() => void>(),
    runNativeChatCliFork: vi.fn(),
    runCliChatResume: vi.fn(async () => {}),
    listSessions: vi.fn()
  }
})

vi.mock('./native-chat-cli-fork-run', () => ({
  runNativeChatCliFork: mocks.runNativeChatCliFork,
  useNativeChatCliForkPending: () =>
    useSyncExternalStore(
      (listener) => {
        mocks.pendingListeners.add(listener)
        return () => mocks.pendingListeners.delete(listener)
      },
      () => mocks.pending
    )
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        settings: null,
        unifiedTabsByWorktree: mocks.sideChatSource ? { 'wt-1': [{ id: 'tab-1' }] } : {}
      }),
    { getState: () => ({}) }
  )
}))

vi.mock('@/runtime/structured-agent-session-owner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  structuredAgentSessionOwnerForTab: () => 'local'
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: () => true
}))
vi.mock('../native-chat/use-native-chat-side-chat', () => ({
  useNativeChatSideChat: () => (mocks.sideChatSource ? mocks.openSideChat : null)
}))

vi.mock('./tab-session-history-switch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTabSessionHistorySubject: () => mocks.subject
}))

vi.mock('./cli-chat-resume-source', () => ({ resolveCliChatResumeSource: () => mocks.cliSource }))
vi.mock('./cli-chat-resume-run', () => ({
  runCliChatResume: mocks.runCliChatResume,
  useCliChatResumePending: () => false
}))

beforeEach(() => {
  mocks.subject = null
  mocks.cliSource = null
  mocks.pending = false
  mocks.sideChatSource = false
  mocks.openSideChat.mockClear()
  mocks.runNativeChatCliFork.mockReset()
  mocks.runCliChatResume.mockClear()
  mocks.listSessions.mockReset()
  mocks.listSessions.mockReturnValue(new Promise(() => {}))
  Object.assign(window, {
    api: {
      aiVault: { listSessions: mocks.listSessions, cancelListSessions: vi.fn(async () => {}) }
    }
  })
})

afterEach(() => {
  vi.useFakeTimers()
  try {
    cleanup()
    // Finish Radix's deferred unmount focus before the next menu mounts.
    act(() => vi.runOnlyPendingTimers())
  } finally {
    vi.useRealTimers()
  }
})

function renderItemsNow(structuredSessionId?: string, agent = 'claude'): void {
  render(
    <TooltipProvider>
      <ContextMenu>
        <ContextMenuTrigger>Open</ContextMenuTrigger>
        <ContextMenuContent>
          <TabSessionSurfaceSwitchMenuItems
            tab={{ id: 'tab-1', worktreeId: 'wt-1' }}
            nativeChat={structuredSessionId ? { sessionId: structuredSessionId, agent } : undefined}
            leadingSeparator
          />
        </ContextMenuContent>
      </ContextMenu>
    </TooltipProvider>
  )
  fireEvent.pointerDown(screen.getByText('Open'), { button: 2, pointerType: 'mouse' })
  fireEvent.contextMenu(screen.getByText('Open'), { button: 2, clientX: 16, clientY: 8 })
}

describe('TabSessionSurfaceSwitchMenuItems', () => {
  it('opens the Codex tab side-chat submenu inside the real context menu', async () => {
    mocks.sideChatSource = true
    renderItemsNow('orca-chat-1', 'codex')
    await screen.findByRole('menu')
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'New side chat' }), {
      key: 'ArrowRight'
    })
    expect(await screen.findByRole('menuitem', { name: 'Read only' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: 'Use main chat permissions' })).toBeDefined()
    expect(mocks.openSideChat).not.toHaveBeenCalled()
  })
})
