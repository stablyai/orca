// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resetAiVaultForcedRescanThrottleForTest } from '../right-sidebar/ai-vault-session-refresh'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'

const mocks = vi.hoisted(() => {
  const state: {
    subject: Record<string, unknown> | null
    move: { action: string; worktreeId: string } | null
    subjectArgs: unknown[]
  } = { subject: null, move: null, subjectArgs: [] }
  return {
    ...state,
    handleResumeInNewChat: vi.fn(),
    listSessions: vi.fn(),
    toastError: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ settings: null }),
    { getState: () => ({}) }
  )
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ settings: null }),
    { getState: () => ({}) }
  )
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

vi.mock('../right-sidebar/ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: () => ({
    handleResumeInNewChat: mocks.handleResumeInNewChat,
    handleResumeInNewCli: vi.fn()
  })
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
  mocks.subject = null
  mocks.move = null
  mocks.subjectArgs = []
  mocks.handleResumeInNewChat.mockReset()
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
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" />
    </TooltipProvider>
  )
  expect(mocks.listSessions).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resume in New Native Chat' }))
  })
}

describe('TerminalPaneResumeInChatButton', () => {
  it('runs the tab menu move on click, for the pane tab', async () => {
    mocks.subject = CLI_SUBJECT
    mocks.move = { action: 'resume-in-new-chat', worktreeId: 'wt-1' }
    await clickResume()
    expect(mocks.subjectArgs).toEqual([{ tab: { id: 'tab-1', worktreeId: 'wt-1' } }])
    expect(mocks.handleResumeInNewChat).toHaveBeenCalledWith(CLI_ROW, 'wt-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('says so when the Session History gate withholds the move', async () => {
    mocks.subject = CLI_SUBJECT
    await clickResume()
    expect(mocks.handleResumeInNewChat).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('says so without a lookup when the tab has no history session yet', async () => {
    await clickResume()
    expect(mocks.listSessions).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('says so when the lookup fails', async () => {
    mocks.subject = CLI_SUBJECT
    mocks.listSessions.mockRejectedValue(new Error('host unreachable'))
    await clickResume()
    expect(mocks.handleResumeInNewChat).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })
})
