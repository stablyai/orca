// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  claimAiVaultForcedRescan,
  resetAiVaultForcedRescanThrottleForTest
} from '../right-sidebar/ai-vault-session-refresh'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'

const mocks = vi.hoisted(() => {
  const state: {
    subject: Record<string, unknown> | null
    move: { action: string; worktreeId: string } | null
    subjectArgs: unknown[]
    tabOpen: boolean
  } = { subject: null, move: null, subjectArgs: [], tabOpen: true }
  return {
    ...state,
    resumeInNewChat: vi.fn(async () => {}),
    activateChat: vi.fn(async () => true),
    listSessions: vi.fn(),
    toastError: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ tabsByWorktree: { 'wt-1': mocks.tabOpen ? [{ id: 'tab-1' }] : [] } })
  }
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('../tab-bar/tab-session-history-switch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTabSessionHistorySubject: (_state: unknown, args: unknown) => {
    mocks.subjectArgs.push(args)
    return mocks.subject
  },
  resolveTabSessionSwitch: () => mocks.move
}))

vi.mock('../right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.resumeInNewChat
}))

vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activateChat
}))

const CLI_ROW: AiVaultSession = {
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
  subagent: null
}

const CLI_SUBJECT = {
  kind: 'cli',
  agent: 'claude',
  providerSessionId: 'claude-session-1',
  workspaceId: 'wt-1',
  request: { scopePaths: ['/repo/wt'], executionHostScope: 'local', sessionLimit: 250 }
}

beforeEach(() => {
  resetAiVaultForcedRescanThrottleForTest()
  mocks.subject = CLI_SUBJECT
  mocks.move = null
  mocks.subjectArgs = []
  mocks.tabOpen = true
  mocks.resumeInNewChat.mockClear()
  mocks.activateChat.mockClear()
  mocks.toastError.mockReset()
  mocks.listSessions.mockReset()
  mocks.listSessions.mockResolvedValue({ sessions: [CLI_ROW], issues: [], scannedAt: 'now' })
  Object.assign(window, {
    api: { aiVault: { listSessions: mocks.listSessions, cancelListSessions: vi.fn() } }
  })
})

afterEach(cleanup)

async function clickResume(): Promise<void> {
  render(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf-1" />
    </TooltipProvider>
  )
  expect(mocks.listSessions).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resume in New Native Chat' }))
  })
}

describe('TerminalPaneResumeInChatButton', () => {
  it("resumes this pane's own conversation in a new native chat", async () => {
    mocks.move = { action: 'resume-in-new-chat', worktreeId: 'wt-1' }
    await clickResume()
    expect(mocks.subjectArgs).toEqual([
      { tab: { id: 'tab-1', worktreeId: 'wt-1' }, paneKey: 'tab-1:leaf-1' }
    ])
    expect(mocks.resumeInNewChat).toHaveBeenCalledWith(
      CLI_ROW,
      'claude',
      'wt-1',
      expect.any(String)
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('opens the native chat that already holds the conversation', async () => {
    const owned = { ...CLI_ROW, structuredSession: { sessionId: 'chat-1', workspaceId: 'wt-1' } }
    mocks.listSessions.mockResolvedValue({ sessions: [owned], issues: [], scannedAt: 'now' })
    await clickResume()
    expect(mocks.activateChat).toHaveBeenCalledWith(owned)
    expect(mocks.listSessions).toHaveBeenCalledTimes(1)
    expect(mocks.resumeInNewChat).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('says the agent has not saved anything yet, after a fresh scan even inside the budget', async () => {
    claimAiVaultForcedRescan()
    mocks.listSessions.mockResolvedValue({ sessions: [], issues: [], scannedAt: 'now' })
    await clickResume()
    expect(mocks.listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Claude hasn't saved this conversation yet. Try again after it replies."
    )
  })

  it('says plainly when the conversation cannot move, without a retry promise', async () => {
    await clickResume()
    expect(mocks.resumeInNewChat).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This Claude conversation can't be resumed in a native chat."
    )
  })

  it('reports a failed lookup as a failure', async () => {
    mocks.listSessions.mockRejectedValue(new Error('host unreachable'))
    await clickResume()
    expect(mocks.resumeInNewChat).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not resume this session in a new chat.')
  })

  it('does nothing once the tab closed during the lookup', async () => {
    mocks.move = { action: 'resume-in-new-chat', worktreeId: 'wt-1' }
    mocks.listSessions.mockImplementation(async () => {
      mocks.tabOpen = false
      return { sessions: [CLI_ROW], issues: [], scannedAt: 'now' }
    })
    await clickResume()
    expect(mocks.resumeInNewChat).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('looks nothing up when the pane has no conversation any more', async () => {
    mocks.subject = null
    await clickResume()
    expect(mocks.listSessions).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not resume this session in a new chat.')
  })
})
