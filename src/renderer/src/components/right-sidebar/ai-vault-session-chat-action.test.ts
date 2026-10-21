import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import { resolveAiVaultSessionRowChatActions } from './ai-vault-session-chat-action'

const session: AiVaultSession = {
  id: 'local:claude:s-1:/tmp/s-1.jsonl',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 's-1',
  title: 'Fix auth retry',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/tmp/s-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-09-17T00:00:00.000Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [{ role: 'user', text: 'Fix it', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'claude --resume s-1',
  subagent: null
}

const hit: AiVaultSearchHit = {
  agent: 'claude',
  sessionId: 's-1',
  title: 'Fix auth retry',
  cwd: '/repo',
  branch: null,
  updatedAt: null,
  messageCount: 2,
  score: 1,
  source: { presence: 'missing' },
  evidence: null
}

function actions(overrides: Partial<Parameters<typeof resolveAiVaultSessionRowChatActions>[0]>) {
  return resolveAiVaultSessionRowChatActions({
    session,
    originalPaneTarget: null,
    structuredSessionOpen: false,
    resumeState: { blocked: false, worktreeId: 'wt-1', usesSessionWorktree: true },
    resumeInChat: { available: true, workspaceId: 'wt-own' },
    searchHit: undefined,
    ...overrides
  })
}

describe('session row chat actions', () => {
  it('resumes with ▶ only while ▶ is enabled and shown', () => {
    expect(actions({})).toMatchObject({ resumeDisabled: false, resumeWorktreeId: 'wt-1' })
    expect(
      actions({ resumeState: { blocked: true, worktreeId: 'wt-1', usesSessionWorktree: true } })
    ).toMatchObject({ resumeDisabled: true, resumeWorktreeId: null })
    // An open chat hides ▶; switching to it is the only offer.
    expect(actions({ structuredSessionOpen: true }).resumeWorktreeId).toBeNull()
    expect(
      actions({ session: { ...session, messageCount: 0, previewMessages: [] } })
    ).toMatchObject({ resumeDisabled: true, resumeWorktreeId: null })
  })

  it('offers nothing a hidden button would not', () => {
    expect(
      actions({ resumeInChat: { available: false, reason: 'remote' } }).resumeInNewChatWorkspaceId
    ).toBeNull()
    // A search hit whose transcript is gone cannot resume, whatever eligibility said.
    expect(actions({ searchHit: hit })).toEqual({
      canJumpToOriginalPane: false,
      resumeDisabled: true,
      resumeWorktreeId: null,
      resumeInNewChatWorkspaceId: null,
      resumeInNewCliWorktreeId: null
    })
  })
})
