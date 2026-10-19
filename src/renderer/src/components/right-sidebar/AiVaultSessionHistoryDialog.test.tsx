// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { openAgentSessionHistoryModal } from './agent-session-history-modal'
import { resolveAiVaultPanelSessionListRequest } from './ai-vault-panel-session-list-request'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import { AI_VAULT_VIEW_OPTIONS_STORAGE_KEY } from './ai-vault-view-options-persistence'

const mocks = vi.hoisted(() => ({
  scopePaths: new Array<readonly string[]>(),
  sessions: new Array<AiVaultSession>(),
  handleResumeInNewChat: vi.fn()
}))

vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: (scopePaths: readonly string[]) => {
    mocks.scopePaths.push(scopePaths)
    return {
      error: null,
      loading: false,
      refresh: vi.fn(),
      scanResult: null,
      sessions: mocks.sessions,
      loadedSessionLimit: null
    }
  }
}))
vi.mock('./ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: () => ({
    continuationRequest: null,
    handleResume: vi.fn(),
    handleResumeInNewChat: mocks.handleResumeInNewChat,
    handleResumeInNewCli: vi.fn()
  })
}))
vi.mock('./ai-vault-original-pane-actions', () => ({
  useAiVaultOriginalPaneActions: () => ({ jumpToOriginalPane: vi.fn(), jumpToWorktree: vi.fn() })
}))
vi.mock('./ai-vault-session-delete-action', () => ({
  useAiVaultSessionDeleteAction: () => vi.fn()
}))
// The list's rows and keys have their own tests; this one stands in for a row's Resume button.
vi.mock('./AiVaultSessionVirtualList', () => ({
  AiVaultSessionVirtualList: (props: {
    groups: AiVaultSessionListGroup[]
    onResumeInNewChat: (session: null, id: string) => void
  }) => (
    <>
      <button type="button" onClick={() => props.onResumeInNewChat(null, 'wt-own')}>
        Resume row
      </button>
      {props.groups.flatMap((group) => group.sessions.map(({ id }) => <p key={id}>{id}</p>))}
    </>
  )
}))

import AiVaultSessionHistoryDialog from './AiVaultSessionHistoryDialog'
import AiVaultSidebarPanel from './AiVaultSidebarPanel'

const CHAT_WORKTREE = 'repo-1::/repo/chat'
const OTHER_WORKTREE = 'repo-1::/repo/other'

function Host({ withSidebar = false }: { withSidebar?: boolean }) {
  const open = useAppStore((s) => s.activeModal === 'agent-session-history')
  return (
    <ConfirmationDialogProvider>
      <TooltipProvider>
        <textarea aria-label="Composer" />
        {withSidebar ? (
          <div data-testid="sidebar">
            <AiVaultSidebarPanel />
          </div>
        ) : null}
        {open ? <AiVaultSessionHistoryDialog /> : null}
      </TooltipProvider>
    </ConfirmationDialogProvider>
  )
}

function openHistory(initialQuery = '', agent?: AiVaultAgent) {
  act(() =>
    openAgentSessionHistoryModal({
      workspace: { worktreeId: CHAT_WORKTREE },
      chatTabId: 'chat-tab',
      initialQuery,
      ...(agent ? { agent } : {})
    })
  )
}

function chatSession(agent: AiVaultAgent): AiVaultSession {
  return {
    id: `${agent}-chat`,
    executionHostId: 'local',
    agent,
    sessionId: agent,
    title: agent,
    cwd: '/repo/chat',
    branch: null,
    model: null,
    filePath: `/tmp/${agent}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-13T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

function dialogSearch(): HTMLInputElement {
  return within(screen.getByRole('dialog')).getByLabelText<HTMLInputElement>('Search sessions')
}

beforeEach(() => {
  mocks.scopePaths.length = 0
  mocks.sessions = []
  mocks.handleResumeInNewChat.mockReset()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeRepoId: 'repo-1',
    activeWorktreeId: OTHER_WORKTREE,
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(CHAT_WORKTREE, 'chat', { path: '/repo/chat' }),
        makeWorktree(OTHER_WORKTREE, 'other', { path: '/repo/other' })
      ]
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions: vi.fn(() => new Promise(() => {})) } }
  })
})
afterEach(cleanup)

describe('Session History dialog', () => {
  it('stays open when a resume fails, and closes without taking focus once it opens a tab', async () => {
    render(<Host />)
    const composer = screen.getByLabelText('Composer')
    composer.focus()
    openHistory('auth')
    await waitFor(() => expect(dialogSearch()).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Resume row' }))
    expect(useAppStore.getState().activeModal).toBe('agent-session-history')
    expect(dialogSearch().value).toBe('auth')

    mocks.handleResumeInNewChat.mockImplementation(() =>
      useAppStore.setState({
        activeGroupIdByWorktree: { [OTHER_WORKTREE]: 'group-1' },
        groupsByWorktree: {
          [OTHER_WORKTREE]: [
            { id: 'group-1', worktreeId: OTHER_WORKTREE, activeTabId: 'resumed', tabOrder: [] }
          ]
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume row' }))
    await waitFor(() => expect(useAppStore.getState().activeModal).toBe('none'))
    expect(composer).not.toHaveFocus()
  })

  it("opens on the chat's workspace with the search filled; Escape clears, then closes", async () => {
    render(<Host />)
    const composer = screen.getByLabelText('Composer')
    composer.focus()
    openHistory('auth')
    await waitFor(() => expect(dialogSearch()).toHaveFocus())
    expect(dialogSearch().value).toBe('auth')
    const chatRequest = resolveAiVaultPanelSessionListRequest(useAppStore.getState(), CHAT_WORKTREE)
    expect(mocks.scopePaths.at(-1)).toEqual(chatRequest.scopePaths)

    fireEvent.keyDown(dialogSearch(), { key: 'Escape' })
    expect(dialogSearch().value).toBe('')
    fireEvent.keyDown(dialogSearch(), { key: 'Escape' })
    expect(useAppStore.getState().activeModal).toBe('none')
    await waitFor(() => expect(composer).toHaveFocus())
  })

  it("keeps its search apart from the sidebar's and leaves Settings' request to the sidebar", async () => {
    render(<Host withSidebar />)
    const sidebarSearch = within(screen.getByTestId('sidebar')).getByLabelText<HTMLInputElement>(
      'Search sessions'
    )
    fireEvent.change(sidebarSearch, { target: { value: 'sidebar text' } })
    openHistory('auth')
    await waitFor(() => expect(dialogSearch()).toHaveFocus())
    act(() => useAppStore.getState().showAiVaultSearch())

    expect(dialogSearch().value).toBe('auth')
    expect(sidebarSearch.value).toBe('sidebar text')
    expect(
      screen.getByRole('radiogroup', { name: 'Session History scope: current workspace' })
    ).toBeInTheDocument()
    expect(useAppStore.getState().aiVaultSearchFocusRequested).toBe(false)
  })

  it("starts on the chat's agent without touching the sidebar's saved filter", () => {
    mocks.sessions = [chatSession('claude'), chatSession('codex')]
    window.localStorage.removeItem(AI_VAULT_VIEW_OPTIONS_STORAGE_KEY)
    render(<Host />)
    openHistory('', 'claude')

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('claude-chat')).toBeInTheDocument()
    expect(dialog.queryByText('codex-chat')).toBeNull()
    expect(window.localStorage.getItem(AI_VAULT_VIEW_OPTIONS_STORAGE_KEY)).toBeNull()
  })

  it('starts an OpenCode chat on both names its sessions list under', () => {
    mocks.sessions = [chatSession('opencode2'), chatSession('claude')]
    render(<Host />)
    openHistory('', 'opencode')

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('opencode2-chat')).toBeInTheDocument()
    expect(dialog.queryByText('claude-chat')).toBeNull()
  })
})
