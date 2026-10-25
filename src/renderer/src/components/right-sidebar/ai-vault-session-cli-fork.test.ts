import { OpenCodeCopyServerRouteError } from '../../../../shared/opencode-launch-command'
import { describe, expect, it } from 'vitest'
import {
  aiVaultSessionCliForkWorktreeId,
  describeAiVaultCliForkFailure
} from './ai-vault-session-cli-fork'

const OWNED = { sessionId: 'chat-1', workspaceId: 'repo-1::worktree-1' }
const ROW = { sessionId: 's1', filePath: '/sessions/s1.jsonl' }
const RESUMABLE = { worktreeId: 'repo-1::worktree-2', disabled: false }

describe('Switch to Terminal eligibility', () => {
  it('offers the fork for Claude and Codex rows native chat owns', () => {
    expect(
      aiVaultSessionCliForkWorktreeId(
        { agent: 'claude', ...ROW, structuredSession: OWNED },
        RESUMABLE
      )
    ).toBe('repo-1::worktree-2')
    expect(
      aiVaultSessionCliForkWorktreeId(
        { agent: 'codex', ...ROW, structuredSession: OWNED },
        RESUMABLE
      )
    ).toBe('repo-1::worktree-2')
  })

  it.each(['grok', 'pi'] as const)('offers the fork for a %s chat row', (agent) => {
    expect(
      aiVaultSessionCliForkWorktreeId({ agent, ...ROW, structuredSession: OWNED }, RESUMABLE)
    ).toBe('repo-1::worktree-2')
  })

  it.each(['opencode', 'opencode2', 'omp'] as const)(
    'offers it for a %s chat row, whose chat makes the copy',
    (agent) => {
      expect(
        aiVaultSessionCliForkWorktreeId({ agent, ...ROW, structuredSession: OWNED }, RESUMABLE)
      ).toBe('repo-1::worktree-2')
    }
  )

  it('withholds it from a Pi row whose session file is unknown, as on a remote search hit', () => {
    expect(
      aiVaultSessionCliForkWorktreeId(
        { agent: 'pi', ...ROW, filePath: '', structuredSession: OWNED },
        RESUMABLE
      )
    ).toBeNull()
  })

  it('leaves rows no chat owns to plain Resume', () => {
    expect(aiVaultSessionCliForkWorktreeId({ agent: 'claude', ...ROW }, RESUMABLE)).toBeNull()
  })

  it('withholds the fork when resume is blocked or has no target', () => {
    const session = { agent: 'claude' as const, ...ROW, structuredSession: OWNED }
    expect(
      aiVaultSessionCliForkWorktreeId(session, {
        worktreeId: 'w',
        disabled: true
      })
    ).toBeNull()
    expect(
      aiVaultSessionCliForkWorktreeId(session, {
        worktreeId: null,
        disabled: false
      })
    ).toBeNull()
  })
})

describe('Switch to Terminal failure text', () => {
  const UPDATE = 'Update Orca on the host that runs this chat to resume it in a new CLI.'

  it.each([
    'agent_session_conflict',
    'agent_session_ownership_unknown',
    // Electron wraps an error thrown by a main-process handler.
    "Error invoking remote method 'aiVault:prepareSessionResume': Error: agent_session_conflict"
  ])('asks for a host update when an older host refuses the fork: %s', (message) => {
    expect(describeAiVaultCliForkFailure(message)).toBe(UPDATE)
  })

  it('keeps server refusal feedback plain when Electron wraps the host error', () => {
    const message = new OpenCodeCopyServerRouteError().message
    expect(
      describeAiVaultCliForkFailure(
        `Error invoking remote method 'aiVault:prepareSessionResume': Error: ${message}`
      )
    ).toBe(message)
  })

  it('passes any other failure through unchanged', () => {
    const message = 'The session host is unavailable. Reconnect it and retry resume.'
    expect(describeAiVaultCliForkFailure(message)).toBe(message)
  })
})
