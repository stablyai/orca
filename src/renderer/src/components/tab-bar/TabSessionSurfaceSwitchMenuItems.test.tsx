// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resetAiVaultForcedRescanThrottleForTest } from '../right-sidebar/ai-vault-session-refresh'
import { cacheAiVaultSessionList } from '../right-sidebar/ai-vault-session-list-request'
import { TabSessionSurfaceSwitchMenuItems } from './TabSessionSurfaceSwitchMenuItems'

const mocks = vi.hoisted(() => {
  const state: {
    subject: Record<string, unknown> | null
    move: { action: string; worktreeId: string } | null
    launchActionArgs: unknown[]
  } = { subject: null, move: null, launchActionArgs: [] }
  return {
    ...state,
    handleResumeInNewChat: vi.fn(),
    handleResumeInNewCli: vi.fn(),
    resolveSwitch: vi.fn(),
    listSessions: vi.fn(),
    cancelListSessions: vi.fn(async () => {})
  }
})

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ settings: null }),
    { getState: () => ({}) }
  )
}))

vi.mock('./tab-session-history-switch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTabSessionHistorySubject: () => mocks.subject,
  resolveTabSessionSwitch: mocks.resolveSwitch
}))

vi.mock('../right-sidebar/ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: (args: unknown) => {
    mocks.launchActionArgs.push(args)
    return {
      handleResumeInNewChat: mocks.handleResumeInNewChat,
      handleResumeInNewCli: mocks.handleResumeInNewCli
    }
  }
}))

const CHAT_ROW: AiVaultSession = {
  id: 'row-1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'claude-session-1',
  title: 'Fix the build',
  cwd: '/repo/wt',
  branch: null,
  model: null,
  filePath: '/home/.claude/projects/repo/claude-session-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-08T00:00:00.000Z',
  messageCount: 2,
  totalTokens: 10,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null,
  structuredSession: { sessionId: 'orca-chat-1', workspaceId: 'wt-1' }
}

const PANEL_REQUEST = {
  scopePaths: ['/repo/wt'],
  executionHostScope: 'local',
  sessionLimit: 250
} as const

const CHAT_SUBJECT = {
  kind: 'chat',
  sessionId: 'orca-chat-1',
  workspaceId: 'wt-1',
  request: PANEL_REQUEST
}

const CLI_SUBJECT = {
  kind: 'cli',
  agent: 'claude',
  providerSessionId: 'claude-session-1',
  workspaceId: 'wt-1',
  request: PANEL_REQUEST
}

function listResult(sessions: AiVaultSession[]) {
  return { sessions, issues: [], scannedAt: 'now' }
}

beforeEach(() => {
  resetAiVaultForcedRescanThrottleForTest()
  mocks.subject = null
  mocks.move = null
  mocks.launchActionArgs = []
  mocks.handleResumeInNewChat.mockReset()
  mocks.handleResumeInNewCli.mockReset()
  mocks.resolveSwitch.mockReset()
  mocks.resolveSwitch.mockImplementation(() => mocks.move)
  mocks.listSessions.mockReset()
  mocks.listSessions.mockResolvedValue({
    sessions: [CHAT_ROW],
    issues: [],
    scannedAt: 'now'
  })
  Object.assign(window, {
    api: {
      aiVault: {
        listSessions: mocks.listSessions,
        cancelListSessions: mocks.cancelListSessions
      }
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
            tab={{ id: 'tab-1', worktreeId: 'wt-1', launchAgent: 'claude' }}
            structuredSessionId={structuredSessionId}
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

  it('hides the move when the Session History gate withholds it', async () => {
    mocks.subject = CHAT_SUBJECT
    await renderItems('orca-chat-1')
    expect(mocks.listSessions).toHaveBeenCalled()
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('runs the Session History "Resume in New CLI" handler on the row, in the tab workspace', async () => {
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')

    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.queryByText('Resume in New Native Chat')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume in New CLI' }))
    expect(mocks.handleResumeInNewCli).toHaveBeenCalledWith(CHAT_ROW, 'wt-1')
    expect(mocks.launchActionArgs.at(-1)).toMatchObject({
      activeWorktree: null,
      activeWorktreeId: 'wt-1'
    })
  })

  it('runs the Session History "Resume in New Native Chat" handler for a CLI tab', async () => {
    const cliRow = { ...CHAT_ROW, structuredSession: undefined }
    mocks.listSessions.mockResolvedValue({
      sessions: [cliRow],
      issues: [],
      scannedAt: 'now'
    })
    mocks.subject = CLI_SUBJECT
    mocks.move = { action: 'resume-in-new-chat', worktreeId: 'wt-1' }
    await renderItems()

    expect(screen.queryByText('Resume in New CLI')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume in New Native Chat' }))
    expect(mocks.handleResumeInNewChat).toHaveBeenCalledWith(cliRow, 'wt-1')
  })

  it('offers nothing before the fresh answer and never shows a stale cached row', async () => {
    // The cached row predates a chat taking the conversation; only the fresh reply knows.
    const cliRow = { ...CHAT_ROW, structuredSession: undefined }
    cacheAiVaultSessionList(PANEL_REQUEST, listResult([cliRow]), { replaceHostEntries: false })
    mocks.listSessions.mockResolvedValue(listResult([CHAT_ROW]))
    mocks.subject = CLI_SUBJECT
    mocks.move = { action: 'resume-in-new-chat', worktreeId: 'wt-1' }
    renderItemsNow()

    expect(screen.queryByRole('menuitem')).toBeNull()
    await act(async () => {})
    expect(mocks.listSessions).toHaveBeenCalledWith(expect.objectContaining({ force: undefined }))
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('offers the move once the fresh answer has it', async () => {
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    renderItemsNow('orca-chat-1')

    expect(screen.queryByRole('menuitem')).toBeNull()
    await act(async () => {})
    expect(screen.getByRole('menuitem', { name: 'Resume in New CLI' })).toBeTruthy()
  })

  it('ignores a lookup that settles after the menu closed', async () => {
    let settle: (result: ReturnType<typeof listResult>) => void = () => {}
    mocks.listSessions.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')
    cleanup()
    await act(async () => settle(listResult([CHAT_ROW])))

    expect(mocks.resolveSwitch).not.toHaveBeenCalled()
  })

  it('shows nothing when the lookup fails', async () => {
    mocks.listSessions.mockRejectedValue(new Error('scanner crashed'))
    mocks.subject = CHAT_SUBJECT
    mocks.move = { action: 'resume-in-new-cli', worktreeId: 'wt-1' }
    await renderItems('orca-chat-1')

    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('cancels its lookup when the menu closes', async () => {
    mocks.subject = CHAT_SUBJECT
    mocks.listSessions.mockReturnValue(new Promise(() => {}))
    await renderItems('orca-chat-1')
    cleanup()
    expect(mocks.cancelListSessions).toHaveBeenCalledWith({
      requestToken: expect.any(String)
    })
  })
})
