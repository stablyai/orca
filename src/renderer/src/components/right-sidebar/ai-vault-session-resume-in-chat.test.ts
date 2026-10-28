import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resolveAiVaultSessionResumeInChatEligibility } from './ai-vault-session-resume-in-chat'

type ResumeInChatSession = Parameters<
  typeof resolveAiVaultSessionResumeInChatEligibility
>[0]['session']

const WORKSPACE_PATH = '/repo/orca'

function session(overrides: Partial<ResumeInChatSession> = {}): ResumeInChatSession {
  return {
    agent: 'claude',
    cwd: WORKSPACE_PATH,
    filePath: '/home/dev/.claude/projects/-repo-orca/session-1.jsonl',
    executionHostId: 'local',
    messageCount: 12,
    previewMessages: [],
    ...overrides
  }
}

function eligibility(
  overrides: Partial<Parameters<typeof resolveAiVaultSessionResumeInChatEligibility>[0]> = {}
) {
  return resolveAiVaultSessionResumeInChatEligibility({
    session: session(),
    targetWorkspaceId: 'repo-1::/repo/orca',
    targetWorkspacePath: WORKSPACE_PATH,
    structuredRouteAvailable: true,
    ...overrides
  })
}

describe('resolveAiVaultSessionResumeInChatEligibility', () => {
  it('refuses a row already adopted into a chat before any other check', () => {
    expect(
      eligibility({
        session: {
          ...session(),
          structuredSession: { sessionId: 'claude_1', workspaceId: 'repo-1::/repo/orca' }
        }
      })
    ).toEqual({ available: false, reason: 'already-structured' })
  })

  it.each(['ssh:build-box', 'runtime:unresolved-owner'] as const)(
    'refuses a row recorded on %s',
    (executionHostId) => {
      expect(eligibility({ session: session({ executionHostId }) })).toEqual({
        available: false,
        reason: 'remote'
      })
    }
  )

  it.each<AiVaultSession['agent']>(['claude', 'codex'])(
    'offers a paired-runtime %s conversation when its route is admitted',
    (agent) => {
      expect(
        eligibility({ session: session({ agent, executionHostId: 'runtime:server-1' }) })
      ).toMatchObject({ available: true })
    }
  )

  it('rejects WSL transcripts on a paired runtime too', () => {
    expect(
      eligibility({
        session: session({
          executionHostId: 'runtime:server-1',
          filePath: '//wsl.localhost/Ubuntu/home/dev/.claude/projects/p/session.jsonl'
        })
      })
    ).toEqual({ available: false, reason: 'remote' })
  })

  it('refuses when the same pair could not take the structured route for a fresh chat', () => {
    expect(eligibility({ structuredRouteAvailable: false })).toEqual({
      available: false,
      reason: 'workspace'
    })
  })
})

describe('workspace matching, which binds the agents that store conversations per folder', () => {
  it.each<AiVaultSession['agent']>(['claude', 'grok', 'omp', 'opencode', 'opencode2', 'pi'])(
    'refuses a %s row whose conversation was recorded in another workspace',
    (agent) => {
      // These key conversations by launch cwd, so resuming elsewhere finds or loads nothing.
      expect(
        eligibility({
          session: session({ agent, cwd: '/repo/other' }),
          targetWorkspacePath: WORKSPACE_PATH
        })
      ).toEqual({ available: false, reason: 'workspace' })
    }
  )

  it('refuses a Claude row that recorded no cwd', () => {
    expect(eligibility({ session: session({ cwd: null }) })).toEqual({
      available: false,
      reason: 'workspace'
    })
  })

  it('keeps Codex available in a different workspace, and with no recorded cwd', () => {
    // Codex is handed the rollout file and a cwd, so it resumes anywhere.
    expect(eligibility({ session: session({ agent: 'codex', cwd: '/repo/other' }) })).toMatchObject(
      { available: true }
    )
    expect(eligibility({ session: session({ agent: 'codex', cwd: null }) })).toMatchObject({
      available: true
    })
  })

  it('treats Windows spellings of one directory as the same workspace', () => {
    expect(
      eligibility({
        session: session({ cwd: 'C:\\Users\\Dev\\repo\\Orca\\' }),
        targetWorkspacePath: 'c:/users/dev/repo/orca'
      })
    ).toMatchObject({ available: true })
  })
})
