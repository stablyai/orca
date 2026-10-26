// @vitest-environment happy-dom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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
    (selector: (state: Record<string, unknown>) => unknown) => selector({ settings: null }),
    { getState: () => ({}) }
  )
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

const CHAT_SUBJECT = {
  kind: 'chat',
  sessionId: 'orca-chat-1',
  workspaceId: 'wt-1',
  request: { scopePaths: ['/repo/wt'], executionHostScope: 'local', sessionLimit: 250 }
}

beforeEach(() => {
  mocks.subject = null
  mocks.cliSource = null
  mocks.pending = false
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

afterEach(cleanup)

function renderItemsNow(structuredSessionId?: string): void {
  render(
    <TooltipProvider>
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TabSessionSurfaceSwitchMenuItems
            tab={{ id: 'tab-1', worktreeId: 'wt-1' }}
            nativeChat={
              structuredSessionId ? { sessionId: structuredSessionId, agent: 'claude' } : undefined
            }
            leadingSeparator
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Continue with Terminal Agent' }))
    expect(mocks.runNativeChatCliFork).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: CHAT_SUBJECT,
        tab: { id: 'tab-1', worktreeId: 'wt-1' },
        agent: 'claude'
      })
    )
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Continue in Chat UI' }))
    await act(async () => {})
    expect(mocks.runCliChatResume).toHaveBeenCalledWith(source)
    expect(mocks.listSessions).not.toHaveBeenCalled()
  })
})

it('keeps an accepted native action visible with shared disabled spinner feedback', async () => {
  mocks.subject = CHAT_SUBJECT
  mocks.runNativeChatCliFork.mockImplementation(() => {
    mocks.pending = true
    mocks.pendingListeners.forEach((listener) => listener())
  })
  await renderItems('orca-chat-1')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Continue with Terminal Agent' }))
  const item = screen.getByRole('menuitem', { name: 'Continue with Terminal Agent' })
  expect(item.getAttribute('aria-busy')).toBe('true')
  expect(item.getAttribute('data-disabled')).not.toBeNull()
  expect(item.querySelector('.animate-spin')).not.toBeNull()
})
