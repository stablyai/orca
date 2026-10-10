import { describe, expect, it } from 'vitest'
import { resolveAiVaultSessionSurfaceSwitchTargets } from './ai-vault-session-surface-switch'

const TURNS = {
  messageCount: 2,
  previewMessages: [{ role: 'user' as const, text: 'Fix the build', timestamp: null }]
}
const RESUMABLE = {
  blocked: false,
  worktreeId: 'repo-1::wt',
  usesSessionWorktree: true
}
const OWNED = { sessionId: 'chat-1', workspaceId: 'repo-1::wt' }

describe('resolveAiVaultSessionSurfaceSwitchTargets', () => {
  it('offers the CLI fork for a chat-owned row with turns and a resume target', () => {
    expect(
      resolveAiVaultSessionSurfaceSwitchTargets(
        { agent: 'codex', structuredSession: OWNED, ...TURNS },
        RESUMABLE,
        null
      )
    ).toEqual({
      resumeInNewChatWorkspaceId: null,
      resumeInNewCliWorktreeId: 'repo-1::wt'
    })
  })

  it('withholds the CLI fork for an empty or blocked chat row', () => {
    const empty = {
      agent: 'claude' as const,
      structuredSession: OWNED,
      messageCount: 0
    }
    expect(
      resolveAiVaultSessionSurfaceSwitchTargets({ ...empty, previewMessages: [] }, RESUMABLE, null)
        .resumeInNewCliWorktreeId
    ).toBeNull()
    expect(
      resolveAiVaultSessionSurfaceSwitchTargets(
        { agent: 'claude', structuredSession: OWNED, ...TURNS },
        { ...RESUMABLE, blocked: true },
        null
      ).resumeInNewCliWorktreeId
    ).toBeNull()
  })

  it('offers the chat resume only where its eligibility says so', () => {
    const cliRow = { agent: 'claude' as const, ...TURNS }
    expect(
      resolveAiVaultSessionSurfaceSwitchTargets(cliRow, RESUMABLE, {
        available: true,
        workspaceId: 'repo-1::wt'
      })
    ).toEqual({
      resumeInNewChatWorkspaceId: 'repo-1::wt',
      resumeInNewCliWorktreeId: null
    })
    expect(
      resolveAiVaultSessionSurfaceSwitchTargets(cliRow, RESUMABLE, {
        available: false,
        reason: 'remote'
      }).resumeInNewChatWorkspaceId
    ).toBeNull()
  })
})
