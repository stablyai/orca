// @vitest-environment happy-dom

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession, AiVaultSubagentListResult } from '../../../../shared/ai-vault-types'
import { SessionInlineDetails } from './AiVaultSessionDetails'

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
