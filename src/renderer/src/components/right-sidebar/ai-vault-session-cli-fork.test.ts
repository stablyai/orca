import { describe, expect, it } from 'vitest'
import {
  aiVaultSessionCliForkWorktreeId,
  describeAiVaultCliForkFailure
} from './ai-vault-session-cli-fork'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'

const OWNED = { sessionId: 'chat-1', workspaceId: 'repo-1::worktree-1' }
const RESUMABLE = { worktreeId: 'repo-1::worktree-2', disabled: false }

function row(agent: AiVaultAgent) {
  return { agent, sessionId: 'provider-1', structuredSession: OWNED }
}

describe('Resume in New CLI eligibility', () => {
  it('offers the fork for Claude and Codex rows native chat owns', () => {
    expect(aiVaultSessionCliForkWorktreeId(row('claude'), RESUMABLE)).toBe('repo-1::worktree-2')
    expect(aiVaultSessionCliForkWorktreeId(row('codex'), RESUMABLE)).toBe('repo-1::worktree-2')
  })

  it.each(['opencode', 'grok', 'pi'] as const)(
    'offers no fork for %s, whose CLI cannot fork a conversation',
    (agent) => {
      expect(aiVaultSessionCliForkWorktreeId(row(agent), RESUMABLE)).toBeNull()
    }
  )

  it('leaves rows no chat owns to plain Resume', () => {
    expect(
      aiVaultSessionCliForkWorktreeId({ agent: 'claude', sessionId: 'provider-1' }, RESUMABLE)
    ).toBeNull()
  })

  it('withholds the fork when resume is blocked or has no target', () => {
    const session = row('claude')
    expect(aiVaultSessionCliForkWorktreeId(session, { worktreeId: 'w', disabled: true })).toBeNull()
    expect(
      aiVaultSessionCliForkWorktreeId(session, { worktreeId: null, disabled: false })
    ).toBeNull()
  })
})

describe('Resume in New CLI failure text', () => {
  const UPDATE = 'Update Orca on the host that runs this chat to resume it in a new CLI.'

  it.each([
    'agent_session_conflict',
    'agent_session_ownership_unknown',
    // Electron wraps an error thrown by a main-process handler.
    "Error invoking remote method 'aiVault:prepareSessionResume': Error: agent_session_conflict"
  ])('asks for a host update when an older host refuses the fork: %s', (message) => {
    expect(describeAiVaultCliForkFailure(message)).toBe(UPDATE)
  })

  it('passes any other failure through unchanged', () => {
    const message = 'The session host is unavailable. Reconnect it and retry resume.'
    expect(describeAiVaultCliForkFailure(message)).toBe(message)
  })
})
