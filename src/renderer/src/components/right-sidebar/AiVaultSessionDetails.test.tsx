// @vitest-environment happy-dom

import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession, AiVaultSubagentListResult } from '../../../../shared/ai-vault-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SessionInlineDetails } from './AiVaultSessionDetails'

const resumeWebChatSpy = vi.fn()
vi.mock('./ai-vault-web-chat-resume', () => ({
  resumeWebChatAsLocalAgent: (args: unknown) => resumeWebChatSpy(args)
}))

const listSubagentSessions = vi.fn<(args: unknown) => Promise<AiVaultSubagentListResult>>()

beforeEach(() => {
  listSubagentSessions.mockReset()
  listSubagentSessions.mockResolvedValue({ sessions: [], issues: [] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    aiVault: { listSubagentSessions },
    shell: { openFilePath: vi.fn() }
  }
})

afterEach(() => {
  document.body.replaceChildren()
})

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:claude:parent-session:/tmp/parent-session.jsonl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'parent-session',
    title: 'Parent session',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/tmp/parent-session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-05T10:00:00.000Z',
    messageCount: 3,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume parent-session',
    readOnly: false,
    subagent: null,
    ...overrides
  }
}

const resumeActions = {
  worktree: { worktreeId: 'wt-1', disabled: false },
  newTab: { worktreeId: 'wt-2', disabled: false }
}

describe('SessionInlineDetails', () => {
  it('hides the resume buttons for a read-only session even with resumable content', async () => {
    const { queryByText } = render(
      <SessionInlineDetails
        id="session-1"
        session={makeSession({ readOnly: true })}
        worktreeInfo={null}
        vaultScope="workspace"
        resumeActions={resumeActions}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
      />
    )
    await act(async () => {})

    expect(queryByText('Resume in Worktree')).toBeNull()
    expect(queryByText('Resume in New Tab')).toBeNull()
  })

  it('shows the resume buttons for a resumable, non-read-only session', async () => {
    const { queryByText } = render(
      <SessionInlineDetails
        id="session-2"
        session={makeSession({ readOnly: false })}
        worktreeInfo={null}
        vaultScope="workspace"
        resumeActions={resumeActions}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
      />
    )
    await act(async () => {})

    expect(queryByText('Resume in Worktree')).not.toBeNull()
    expect(queryByText('Resume in New Tab')).not.toBeNull()
  })

  it('still renders the conversation preview for a read-only session', async () => {
    const { queryByText } = render(
      <SessionInlineDetails
        id="session-3"
        session={makeSession({
          readOnly: true,
          previewMessages: [
            { role: 'user', text: 'Hello from the web chat import', timestamp: null }
          ]
        })}
        worktreeInfo={null}
        vaultScope="workspace"
        resumeActions={resumeActions}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
      />
    )
    await act(async () => {})

    expect(queryByText('Latest turns')).not.toBeNull()
    expect(queryByText('Hello from the web chat import')).not.toBeNull()
  })
})

describe('SessionInlineDetails web-chat resume', () => {
  beforeEach(() => {
    resumeWebChatSpy.mockClear()
  })

  it('resumes a web-chat session with the resolved agent and active worktree', async () => {
    const session = makeSession({
      readOnly: true,
      agent: 'gemini-web',
      sessionId: 'c_1',
      title: 'Web chat'
    })
    const { getByTestId } = render(
      <SessionInlineDetails
        id="session-web-1"
        session={session}
        worktreeInfo={null}
        vaultScope="workspace"
        resumeActions={resumeActions}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
        webResumeAgent="claude"
        activeWorktreeId="wt-1"
      />
    )
    await act(async () => {})

    fireEvent.click(getByTestId('ai-vault-web-chat-resume'))

    expect(resumeWebChatSpy).toHaveBeenCalledWith({
      session,
      agent: 'claude',
      worktreeId: 'wt-1'
    })
  })

  it('disables web-chat resume and shows a hint when no default agent is set', async () => {
    // Why: the hint now rides a Radix Tooltip (STYLEGUIDE.md forbids `title`), so the
    // trigger needs a TooltipProvider ancestor the way the app root supplies one.
    const { getByTestId, getAllByText, queryByText } = render(
      <TooltipProvider>
        <SessionInlineDetails
          id="session-web-2"
          session={makeSession({ readOnly: true, agent: 'chatgpt' })}
          worktreeInfo={null}
          vaultScope="workspace"
          resumeActions={resumeActions}
          onResumeInWorktree={vi.fn()}
          onResumeInNewTab={vi.fn()}
          webResumeAgent={null}
          activeWorktreeId="wt-1"
        />
      </TooltipProvider>
    )
    await act(async () => {})

    const button = getByTestId('ai-vault-web-chat-resume') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.closest('[title]')).toBeNull()

    const hint = 'Set a default agent before resuming.'
    expect(queryByText(hint)).toBeNull()

    // Focusing the tooltip trigger (the span wrapping the disabled button) opens
    // the tooltip synchronously, the same way keyboard focus does in the app.
    const trigger = button.parentElement as HTMLElement
    await act(async () => {
      fireEvent.focus(trigger)
    })
    expect(getAllByText(hint).length).toBeGreaterThan(0)

    fireEvent.click(button)
    expect(resumeWebChatSpy).not.toHaveBeenCalled()
  })

  it('does not render web-chat resume for a non-web read-only session', async () => {
    const { queryByTestId } = render(
      <SessionInlineDetails
        id="session-web-3"
        session={makeSession({ readOnly: true, agent: 'claude' })}
        worktreeInfo={null}
        vaultScope="workspace"
        resumeActions={resumeActions}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
        webResumeAgent="claude"
        activeWorktreeId="wt-1"
      />
    )
    await act(async () => {})

    expect(queryByTestId('ai-vault-web-chat-resume')).toBeNull()
  })
})
