// @vitest-environment happy-dom

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentLaunchVaultResumeDetailsResult } from '../../../../shared/agent-launch-spawn-request'
import { SessionInlineDetails } from './AiVaultSessionDetails'

const resumeDetails = vi.fn<() => Promise<AgentLaunchVaultResumeDetailsResult>>()

beforeEach(() => {
  resumeDetails.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused preload test shim
  ;(window as any).api = { aiVault: { resumeDetails } }
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('SessionInlineDetails resume arguments', () => {
  it('shows that authoritative arguments are loading while the fresh scan runs', () => {
    resumeDetails.mockImplementation(() => new Promise(() => {}))

    const { queryByText } = render(
      <SessionInlineDetails
        id="details-session-1"
        session={session()}
        worktreeInfo={null}
        vaultScope="all"
        resumeActions={{
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
      />
    )

    expect(queryByText('Loading resume arguments…')).not.toBeNull()
  })

  it('fetches captured arguments on expanded-details mount and shows the effort level', async () => {
    resumeDetails.mockResolvedValue({
      status: 'ok',
      args: ['--model', 'gpt-5.6-Sol', '-c', 'model_reasoning_effort=medium']
    })
    const { queryByText } = render(
      <SessionInlineDetails
        id="details-session-1"
        session={session()}
        worktreeInfo={null}
        vaultScope="all"
        resumeActions={{
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
      />
    )

    await act(async () => {})

    expect(resumeDetails).toHaveBeenCalledOnce()
    expect(queryByText('Resume arguments')).not.toBeNull()
    expect(queryByText('--model gpt-5.6-Sol -c model_reasoning_effort=medium')).not.toBeNull()
  })

  it('keeps expanded details usable while an older preload is still running', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rolling-preload compatibility shim
    ;(window as any).api = { aiVault: {} }

    const { queryByText } = render(
      <SessionInlineDetails
        id="details-session-1"
        session={session()}
        worktreeInfo={null}
        vaultScope="all"
        resumeActions={{
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
      />
    )

    await act(async () => {})
    expect(queryByText('Latest turns')).not.toBeNull()
    expect(queryByText('Resume arguments')).toBeNull()
  })
})

function session(): AiVaultSession {
  return {
    id: 'local:codex:session-1:/tmp/session-1.jsonl',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Session',
    cwd: '/repo',
    branch: null,
    model: 'gpt-5.6-Sol',
    filePath: '/tmp/session-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-13T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [{ role: 'user', text: 'Hello', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume session-1',
    subagent: null
  }
}
