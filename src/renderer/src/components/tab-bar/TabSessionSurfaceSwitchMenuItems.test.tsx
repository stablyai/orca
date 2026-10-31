vi.mock('@/lib/in-place-switch-support', () => ({ useInPlaceSwitchCapability: () => false }))
// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
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
    pendingListeners: new Set<() => void>(),
    runNativeChatCliFork: vi.fn(),
    runNativeChatCliSwitch: vi.fn(),
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

vi.mock('./tab-session-history-switch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTabSessionHistorySubject: () => mocks.subject
}))

vi.mock('./cli-chat-resume-source', () => ({
  useCliChatResumeCapability: (_worktreeId: string, agent: string) => agent === 'codex',
  resolveCliChatResumeSource: () => mocks.cliSource
}))
vi.mock('@/lib/conversation-surface-switch', () => ({
  runCliChatResume: mocks.runCliChatResume,
  runNativeChatCliSwitch: mocks.runNativeChatCliSwitch,
  useConversationSwitchReadiness: () => {
    const pending = useSyncExternalStore(
      (listener) => {
        mocks.pendingListeners.add(listener)
        return () => mocks.pendingListeners.delete(listener)
      },
      () => mocks.pending
    )
    return { ready: !pending, pending }
  }
}))

const CHAT_SUBJECT = {
  kind: 'chat',
  sessionId: 'orca-chat-1',
  workspaceId: 'wt-1',
  request: { scopePaths: ['/repo/wt'], executionHostScope: 'local', sessionLimit: 250 }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture(),
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [makeWorktree('wt-1', 'Worktree', { path: '/repo/wt' })] }
  })
  mocks.subject = null
  mocks.cliSource = null
  mocks.pending = false
  mocks.runNativeChatCliFork.mockReset()
  mocks.runNativeChatCliSwitch.mockReset()
  mocks.runCliChatResume.mockClear()
  mocks.listSessions.mockReset()
  mocks.listSessions.mockReturnValue(new Promise(() => {}))
  Object.assign(window, {
    api: {
      aiVault: { listSessions: mocks.listSessions, cancelListSessions: vi.fn(async () => {}) }
    }
  })
})

afterEach(cleanup)

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
  fireEvent.contextMenu(screen.getByText('Open'), { button: 2, clientX: 16, clientY: 8 })
}

async function renderItems(structuredSessionId?: string): Promise<void> {
  renderItemsNow(structuredSessionId)
  await act(async () => {})
}

describe('TabSessionSurfaceSwitchMenuItems', () => {
  it('looks nothing up and shows nothing for a tab without a history session', async () => {
    await renderItems()
    expect(mocks.listSessions).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('offers the native chat action immediately while History never answers', async () => {
    mocks.subject = CHAT_SUBJECT
    renderItemsNow('orca-chat-1')
    expect(mocks.listSessions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to CLI' }))
    expect(mocks.runNativeChatCliSwitch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'orca-chat-1',
        workspaceId: 'wt-1',
        chatTabId: 'tab-1',
        agent: 'claude'
      })
    )
  })

  it('keeps the copy-in-a-new-terminal item for a chat agent that cannot switch in place', async () => {
    mocks.subject = CHAT_SUBJECT
    renderItemsNow('orca-chat-1', 'omp')
    expect(screen.queryByRole('menuitem', { name: 'Switch to CLI' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem'))
    expect(mocks.runNativeChatCliFork).toHaveBeenCalledWith(
      expect.objectContaining({ subject: CHAT_SUBJECT, agent: 'omp' })
    )
    expect(mocks.runNativeChatCliSwitch).not.toHaveBeenCalled()
  })

  it('offers and dispatches a CLI identity while History never answers', async () => {
    const source = {
      tabId: 'tab-1',
      workspaceId: 'wt-1',
      paneKey: 'tab-1:leaf',
      agent: 'claude',
      providerSessionId: 'provider-1',
      executionHostId: 'local'
    }
    mocks.cliSource = source
    renderItemsNow()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to native chat' }))
    await act(async () => {})
    expect(mocks.runCliChatResume).toHaveBeenCalledWith(source, expect.any(Function))
    expect(mocks.listSessions).not.toHaveBeenCalled()
  })
})

it('keeps an accepted native action visible with shared disabled spinner feedback', async () => {
  mocks.subject = CHAT_SUBJECT
  mocks.runNativeChatCliSwitch.mockImplementation(() => {
    mocks.pending = true
    mocks.pendingListeners.forEach((listener) => listener())
  })
  await renderItems('orca-chat-1')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to CLI' }))
  const item = screen.getByRole('menuitem', { name: 'Switch to CLI' })
  expect(item.getAttribute('aria-busy')).toBe('true')
  expect(item.getAttribute('data-disabled')).not.toBeNull()
  expect(item.querySelector('.animate-spin')).not.toBeNull()
})

vi.mock('@/components/confirmation-dialog-context', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirmationDialog: () => vi.fn(async () => false)
}))
