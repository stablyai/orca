import { describe, expect, it } from 'vitest'
import {
  aiVaultSessionCliForkWorktreeId,
  describeAiVaultCliForkFailure
} from './ai-vault-session-cli-fork'

const OWNED = { sessionId: 'chat-1', workspaceId: 'repo-1::worktree-1' }
const RESUMABLE = { worktreeId: 'repo-1::worktree-2', disabled: false }

describe('Resume in New CLI eligibility', () => {
  it('offers the fork for Claude and Codex rows native chat owns', () => {
    expect(
      aiVaultSessionCliForkWorktreeId({ agent: 'claude', structuredSession: OWNED }, RESUMABLE)
    ).toBe('repo-1::worktree-2')
    expect(
      aiVaultSessionCliForkWorktreeId({ agent: 'codex', structuredSession: OWNED }, RESUMABLE)
    ).toBe('repo-1::worktree-2')
  })

  it('leaves rows no chat owns to plain Resume', () => {
    expect(aiVaultSessionCliForkWorktreeId({ agent: 'claude' }, RESUMABLE)).toBeNull()
  })

  it('withholds the fork when resume is blocked or has no target', () => {
    const session = { agent: 'claude' as const, structuredSession: OWNED }
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
