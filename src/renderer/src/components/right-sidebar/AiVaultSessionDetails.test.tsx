// @vitest-environment happy-dom

import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession, AiVaultSubagentListResult } from '../../../../shared/ai-vault-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SessionInlineDetails } from './AiVaultSessionDetails'

const resumeWebChatSpy = vi.fn()
// The new per-agent actions component consumes both exports; provide stable refs.
vi.mock('./ai-vault-web-chat-resume', () => ({
  WEB_CHAT_RESUME_AGENTS: ['claude', 'codex'],
  resumeWebChatWithAgent: (args: unknown) => resumeWebChatSpy(args)
}))

// Stable worktree reference so useWorktreeById never returns a fresh object per render.
const WT1 = { path: '/repo', branch: 'main' }
vi.mock('@/store/selectors', () => ({
  useWorktreeById: (id: string | null) => (id === 'wt-1' ? WT1 : undefined)
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

  it('renders a resume button for every supported agent on a web-chat session', async () => {
    const { getByTestId } = render(
      <SessionInlineDetails
        id="session-web-1"
        session={makeSession({ readOnly: true, agent: 'gemini-web', sessionId: 'c_1' })}
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

    expect(getByTestId('ai-vault-web-chat-resume-claude')).not.toBeNull()
    expect(getByTestId('ai-vault-web-chat-resume-codex')).not.toBeNull()
  })

  it('resumes with claude carrying the worktree cwd and branch', async () => {
    const session = makeSession({
      readOnly: true,
      agent: 'gemini-web',
      sessionId: 'c_1',
      title: 'Web chat'
    })
    const { getByTestId } = render(
      <SessionInlineDetails
        id="session-web-claude"
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

    fireEvent.click(getByTestId('ai-vault-web-chat-resume-claude'))

    expect(resumeWebChatSpy).toHaveBeenCalledWith({
      session,
      agent: 'claude',
      worktreeId: 'wt-1',
      cwd: '/repo',
      gitBranch: 'main'
    })
  })

  it('resumes with codex when the codex option is chosen', async () => {
    const session = makeSession({
      readOnly: true,
      agent: 'gemini-web',
      sessionId: 'c_1',
      title: 'Web chat'
    })
    const { getByTestId } = render(
      <SessionInlineDetails
        id="session-web-codex"
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

    fireEvent.click(getByTestId('ai-vault-web-chat-resume-codex'))

    expect(resumeWebChatSpy).toHaveBeenCalledWith({
      session,
      agent: 'codex',
      worktreeId: 'wt-1',
      cwd: '/repo',
      gitBranch: 'main'
    })
  })

  it('disables every resume option and shows a hint when no workspace is active', async () => {
    // Why: the hint rides a Radix Tooltip (STYLEGUIDE.md forbids `title`), so the
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
          webResumeAgent="claude"
          activeWorktreeId={null}
        />
      </TooltipProvider>
    )
    await act(async () => {})

    const claudeButton = getByTestId('ai-vault-web-chat-resume-claude') as HTMLButtonElement
    const codexButton = getByTestId('ai-vault-web-chat-resume-codex') as HTMLButtonElement
    expect(claudeButton.disabled).toBe(true)
    expect(codexButton.disabled).toBe(true)
    expect(claudeButton.closest('[title]')).toBeNull()

    const hint = 'Open a workspace before resuming a session.'
    expect(queryByText(hint)).toBeNull()

    // Focusing the tooltip trigger (the span wrapping the disabled button) opens
    // the tooltip synchronously, the same way keyboard focus does in the app.
    const trigger = claudeButton.parentElement as HTMLElement
    await act(async () => {
      fireEvent.focus(trigger)
    })
    expect(getAllByText(hint).length).toBeGreaterThan(0)

    fireEvent.click(claudeButton)
    fireEvent.click(codexButton)
    expect(resumeWebChatSpy).not.toHaveBeenCalled()
  })

  it('does not render web-chat resume options for a non-web read-only session', async () => {
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

    expect(queryByTestId('ai-vault-web-chat-resume-claude')).toBeNull()
    expect(queryByTestId('ai-vault-web-chat-resume-codex')).toBeNull()
  })
})
