import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  aiVaultSessionCwdMatchesWorkspace,
  resolveAiVaultSessionResumeInChatEligibility
} from './ai-vault-session-resume-in-chat'

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
  it('offers the chat for a local Claude row in its own workspace', () => {
    expect(eligibility()).toEqual({ available: true, workspaceId: 'repo-1::/repo/orca' })
  })

  it.each<AiVaultSession['agent']>(['grok', 'omp', 'opencode', 'opencode2', 'pi'])(
    'offers the chat for a local %s row in its own workspace',
    (agent) => {
      expect(eligibility({ session: session({ agent }) })).toEqual({
        available: true,
        workspaceId: 'repo-1::/repo/orca'
      })
    }
  )

  it.each<AiVaultSession['agent']>(['hermes', 'gemini'])(
    'refuses %s, whose chats cannot take over a CLI conversation',
    (agent) => {
      expect(eligibility({ session: session({ agent }) })).toEqual({
        available: false,
        reason: 'agent'
      })
    }
  )

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

  it('refuses a row recorded on a remote host', () => {
    expect(eligibility({ session: session({ executionHostId: 'ssh:build-box' }) })).toEqual({
      available: false,
      reason: 'remote'
    })
  })

  it('refuses a row whose transcript is stored inside WSL', () => {
    expect(
      eligibility({
        session: session({
          filePath: '//wsl.localhost/Ubuntu-22.04/home/dev/.claude/projects/p/session-1.jsonl'
        })
      })
    ).toEqual({ available: false, reason: 'remote' })
  })

  it('refuses a transcript that holds no conversation', () => {
    expect(eligibility({ session: session({ messageCount: 0, previewMessages: [] }) })).toEqual({
      available: false,
      reason: 'empty'
    })
  })

  it('offers a zero-count row whose preview proves the turns exist', () => {
    expect(
      eligibility({
        session: session({
          messageCount: 0,
          previewMessages: [{ role: 'user', text: 'hello', timestamp: null }]
        })
      })
    ).toMatchObject({ available: true })
  })

  it('refuses when the same pair could not take the structured route for a fresh chat', () => {
    expect(eligibility({ structuredRouteAvailable: false })).toEqual({
      available: false,
      reason: 'workspace'
    })
  })

  it('refuses when there is no target workspace at all', () => {
    expect(eligibility({ targetWorkspaceId: null })).toEqual({
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

describe('aiVaultSessionCwdMatchesWorkspace', () => {
  it('ignores separator, case, and a trailing slash', () => {
    expect(aiVaultSessionCwdMatchesWorkspace('C:\\repo\\Orca', 'c:/repo/orca')).toBe(true)
    expect(aiVaultSessionCwdMatchesWorkspace('/repo/orca/', '/repo/orca')).toBe(true)
    expect(aiVaultSessionCwdMatchesWorkspace(' /repo/orca ', '/repo/orca')).toBe(true)
  })

  it('never calls a missing path a match', () => {
    expect(aiVaultSessionCwdMatchesWorkspace(null, '/repo/orca')).toBe(false)
    expect(aiVaultSessionCwdMatchesWorkspace('/repo/orca', null)).toBe(false)
    expect(aiVaultSessionCwdMatchesWorkspace('', '')).toBe(false)
  })

  it('does not treat a sibling directory as the same workspace', () => {
    expect(aiVaultSessionCwdMatchesWorkspace('/repo/orca-2', '/repo/orca')).toBe(false)
  })
})
