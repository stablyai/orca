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

  // Why: only the SSH/relay scanners ever record `executionHostPlatform`, so a local row carries
  // none at all. Deleting it here is what makes this a local Windows session rather than a
  // remote one, and the case fold has to come from the path's own shape instead.
  it('starts in the worktree when the recorded cwd holds the agent config the session would shadow', () => {
    const sourceSession = session('codex')
    delete sourceSession.executionHostPlatform
    sourceSession.cwd = String.raw`C:\Users\Ada`
    sourceSession.filePath = String.raw`C:\Users\ada\.codex\sessions\2026\rollout.jsonl`

    const request = prepareAiVaultSessionContinuation({
      session: sourceSession,
      targetWorktreeId: 'worktree-1',
      targetWorkspacePath: String.raw`C:\Users\ada\Projects\client`
    })

    expect(request.initialCwd).toBe(String.raw`C:\Users\ada\Projects\client`)
    // Why: the continuation still has to describe where the work came from, only not start there.
    expect(request.source.sourceWorkingDirectory).toBe(String.raw`C:\Users\Ada`)
  })

  it('keeps a nested cwd and still redirects a trailing-slash home', () => {
    const nested = session('codex')
    nested.cwd = '/Users/ada/Projects/client'
    nested.filePath = '/Users/ada/.codex/sessions/2026/rollout.jsonl'

    expect(
      prepareAiVaultSessionContinuation({
        session: nested,
        targetWorktreeId: 'worktree-1',
        targetWorkspacePath: '/Users/ada/Desktop/current-worktree'
      }).initialCwd
    ).toBe('/Users/ada/Projects/client')

    const trailing = session('claude')
    trailing.cwd = '/Users/ada/'
    trailing.filePath = '/Users/ada/.claude/projects/client/session.jsonl'

    expect(
      prepareAiVaultSessionContinuation({
        session: trailing,
        targetWorktreeId: 'worktree-1',
        targetWorkspacePath: '/Users/ada/Desktop/current-worktree'
      }).initialCwd
    ).toBe('/Users/ada/Desktop/current-worktree')
  })

  it('falls back to the worktree when the session records no cwd at all', () => {
    const rootless = session()
    rootless.cwd = null

    expect(
      prepareAiVaultSessionContinuation({
        session: rootless,
        targetWorktreeId: 'worktree-1',
        targetWorkspacePath: '/Users/ada/Desktop/current-worktree'
      }).initialCwd
    ).toBe('/Users/ada/Desktop/current-worktree')
  })

  it('reads the declared config root even when the transcript does not name one', () => {
    const declared = session('codex')
    declared.cwd = '/Users/ada'
    // Why: a rollout hardlinked out of the real home still belongs to the config root below it.
    declared.filePath = '/Volumes/scratch/rollouts/rollout.jsonl'
    declared.codexHome = '/Users/ada/.codex'

    expect(
      prepareAiVaultSessionContinuation({
        session: declared,
        targetWorktreeId: 'worktree-1',
        targetWorkspacePath: '/Users/ada/Desktop/current-worktree'
      }).initialCwd
    ).toBe('/Users/ada/Desktop/current-worktree')
  })

  it('leaves a managed or relocated home alone, since no .codex sits in the cwd to shadow it', () => {
    const managed = session('codex')
    managed.cwd = '/Users/ada/Library/Application Support/orca/codex-accounts/acct-1'
    managed.filePath =
      '/Users/ada/Library/Application Support/orca/codex-accounts/acct-1/home/sessions/rollout.jsonl'
    managed.codexHome = '/Users/ada/Library/Application Support/orca/codex-accounts/acct-1/home'

    expect(
      prepareAiVaultSessionContinuation({
        session: managed,
        targetWorktreeId: 'worktree-1',
        targetWorkspacePath: '/Users/ada/Desktop/current-worktree'
      }).initialCwd
    ).toBe('/Users/ada/Library/Application Support/orca/codex-accounts/acct-1')
  })

  // Why: a backslash is an ordinary filename character on a POSIX host, so folding it into a
  // separator would make two different directories compare equal and redirect a usable cwd.
  it('does not treat a POSIX backslash as a separator', () => {
    const posix = session('codex')
    posix.cwd = '/srv/team\\name'
    posix.codexHome = '/srv/team/name/.codex'

    expect(
      prepareAiVaultSessionContinuation({
        session: posix,
        targetWorktreeId: 'worktree-1',
        targetWorkspacePath: '/srv/worktrees/current'
      }).initialCwd
    ).toBe('/srv/team\\name')
  })

  // Why: a workspace can itself be the directory holding the agent config, and then no choice
  // avoids the project-scope downgrade. Redirecting must still not invent a third directory.
  it('offers no worse answer when the target workspace also holds the agent config', () => {
    const shadowed = session('codex')
    shadowed.cwd = '/Users/ada'
    shadowed.filePath = '/Users/ada/.codex/sessions/2026/rollout.jsonl'

    expect(
      prepareAiVaultSessionContinuation({
        session: shadowed,
        targetWorktreeId: 'worktree-1',
        targetWorkspacePath: '/Users/ada'
      }).initialCwd
    ).toBe('/Users/ada')
  })
})
