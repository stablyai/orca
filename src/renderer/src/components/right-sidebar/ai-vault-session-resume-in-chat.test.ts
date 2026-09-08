import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  aiVaultSessionCwdMatchesWorkspace,
  aiVaultSessionResumeInChatWorkspaceId
} from './ai-vault-session-resume-in-chat'

type ResumeInChatSession = Parameters<typeof aiVaultSessionResumeInChatWorkspaceId>[0]['session']

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

function workspaceId(
  overrides: Partial<Parameters<typeof aiVaultSessionResumeInChatWorkspaceId>[0]> = {}
) {
  return aiVaultSessionResumeInChatWorkspaceId({
    session: session(),
    targetWorkspaceId: 'repo-1::/repo/orca',
    targetWorkspacePath: WORKSPACE_PATH,
    structuredRouteAvailable: true,
    ...overrides
  })
}

describe('aiVaultSessionResumeInChatWorkspaceId', () => {
  it('offers the chat for a local Claude row in its own workspace', () => {
    expect(workspaceId()).toBe('repo-1::/repo/orca')
  })

  it.each(['hermes', 'grok', 'opencode'] as AiVaultSession['agent'][])(
    'refuses %s, which has no structured lane',
    (agent) => {
      expect(workspaceId({ session: session({ agent }) })).toBeNull()
    }
  )

  it('refuses a row already adopted into a chat', () => {
    // That row reopens its own chat; a second adoption is a conflict the host would refuse.
    expect(
      workspaceId({
        session: {
          ...session(),
          structuredSession: { sessionId: 'claude_1', workspaceId: 'repo-1::/repo/orca' }
        }
      })
    ).toBeNull()
  })

  it('refuses a row recorded on a remote host', () => {
    expect(workspaceId({ session: session({ executionHostId: 'ssh:build-box' }) })).toBeNull()
  })

  it('refuses a row whose transcript is stored inside WSL', () => {
    expect(
      workspaceId({
        session: session({
          filePath: '//wsl.localhost/Ubuntu-22.04/home/dev/.claude/projects/p/session-1.jsonl'
        })
      })
    ).toBeNull()
  })

  it('refuses a transcript that holds no conversation', () => {
    expect(workspaceId({ session: session({ messageCount: 0, previewMessages: [] }) })).toBeNull()
  })

  it('offers a zero-count row whose preview proves the turns exist', () => {
    // Some parsers only learn the turn count from metadata that may be absent.
    expect(
      workspaceId({
        session: session({
          messageCount: 0,
          previewMessages: [{ role: 'user', text: 'hello', timestamp: null }]
        })
      })
    ).toBe('repo-1::/repo/orca')
  })

  it('refuses when the same pair could not take the structured route for a fresh chat', () => {
    expect(workspaceId({ structuredRouteAvailable: false })).toBeNull()
  })

  it('refuses when there is no target workspace at all', () => {
    expect(workspaceId({ targetWorkspaceId: null })).toBeNull()
  })
})

describe('workspace matching, which only Claude is bound by', () => {
  it('refuses a Claude row whose conversation was recorded in another workspace', () => {
    // Claude's SDK keys transcripts by launch cwd, so resuming elsewhere silently finds nothing.
    expect(
      workspaceId({
        session: session({ cwd: '/repo/other' }),
        targetWorkspacePath: WORKSPACE_PATH
      })
    ).toBeNull()
  })

  it('refuses a Claude row that recorded no cwd', () => {
    expect(workspaceId({ session: session({ cwd: null }) })).toBeNull()
  })

  it('keeps Codex available in a different workspace, and with no recorded cwd', () => {
    // Codex is handed the rollout file and a cwd, so it resumes anywhere.
    expect(workspaceId({ session: session({ agent: 'codex', cwd: '/repo/other' }) })).toBe(
      'repo-1::/repo/orca'
    )
    expect(workspaceId({ session: session({ agent: 'codex', cwd: null }) })).toBe(
      'repo-1::/repo/orca'
    )
  })

  it('treats Windows spellings of one directory as the same workspace', () => {
    expect(
      workspaceId({
        session: session({ cwd: 'C:\\Users\\Dev\\repo\\Orca\\' }),
        targetWorkspacePath: 'c:/users/dev/repo/orca'
      })
    ).toBe('repo-1::/repo/orca')
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
