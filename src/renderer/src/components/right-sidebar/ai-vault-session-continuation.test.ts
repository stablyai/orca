import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  canContinueAiVaultSessionInNewSession,
  prepareAiVaultSessionContinuation
} from './ai-vault-session-continuation'

function session(agent: AiVaultSession['agent'] = 'claude'): AiVaultSession {
  return {
    id: 'session-row-1',
    executionHostId: 'local',
    executionHostPlatform: 'darwin',
    agent,
    sessionId: `${agent}-session-1`,
    title: 'Finish the editor refactor',
    cwd: '/Users/ada/Desktop/Client App',
    branch: 'main',
    model: null,
    filePath: `/Users/ada/.${agent}/projects/client/session.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-15T02:00:00.000Z',
    messageCount: 3,
    totalTokens: 1200,
    lastUserPrompt: 'Finish the editor refactor',
    previewMessages: [
      { role: 'user', text: 'Finish the editor refactor', timestamp: null },
      { role: 'assistant', text: 'The component tests still need work.', timestamp: null },
      { role: 'user', text: 'Tool output that is not a user request', timestamp: null }
    ],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `${agent} --resume session-1`,
    subagent: null
  }
}

describe('AI Vault session continuation', () => {
  it('supports both cross-Agent and same-Agent continuation', () => {
    expect(canContinueAiVaultSessionInNewSession(session('claude'), 'worktree-1')).toBe(true)
    expect(canContinueAiVaultSessionInNewSession(session('codex'), 'worktree-1')).toBe(true)
    expect(canContinueAiVaultSessionInNewSession(session(), null)).toBe(false)
  })

  it('preserves the transcript, stopping point, and historical cwd', () => {
    const request = prepareAiVaultSessionContinuation({
      session: session(),
      targetWorktreeId: 'worktree-1',
      targetWorkspacePath: '/Users/ada/Desktop/current-worktree'
    })

    expect(request).toMatchObject({
      worktreeId: 'worktree-1',
      workspacePath: '/Users/ada/Desktop/current-worktree',
      initialCwd: '/Users/ada/Desktop/Client App',
      launchSource: 'sidebar',
      source: {
        sourceAgent: 'claude',
        lastPrompt: 'Finish the editor refactor',
        lastAssistantMessage: 'The component tests still need work.'
      }
    })
    expect(request.source.transcriptPath).toContain('session.jsonl')
    expect(request.source.capturedText).toContain('assistant: The component tests still need work.')
  })

  it('never treats a preview tool result as the user prompt', () => {
    const sourceSession = session()
    sourceSession.lastUserPrompt = null

    const request = prepareAiVaultSessionContinuation({
      session: sourceSession,
      targetWorktreeId: 'worktree-1',
      targetWorkspacePath: '/Users/ada/Desktop/current-worktree'
    })

    expect(request.source.lastPrompt).toBeNull()
    expect(request.source.lastAssistantMessage).toBe('The component tests still need work.')
  })
})
