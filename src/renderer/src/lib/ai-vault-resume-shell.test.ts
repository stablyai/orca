import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

const clientLoginShell = vi.hoisted(() => ({ value: '' }))

vi.mock('@/lib/client-login-shell', () => ({
  getClientLoginShell: () => clientLoginShell.value
}))

import { buildAiVaultResumeCopyCommandForWorktree } from './ai-vault-resume-command'
import { resolveAiVaultResumeStartupShell } from './ai-vault-resume-shell'

type ResumeShellState = Parameters<typeof buildAiVaultResumeCopyCommandForWorktree>[0]['state']

function makeState(worktreeHostId?: string): ResumeShellState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::worktree-1',
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ id: 'repo-1', path: '/home/alice/repo' }],
    projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
    settings: {
      agentDefaultArgs: { codex: '' },
      agentDefaultEnv: { codex: {} }
    },
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'repo-1::worktree-1',
          repoId: 'repo-1',
          path: '/home/alice/repo',
          ...(worktreeHostId ? { hostId: worktreeHostId } : {})
        }
      ]
    }
  } as unknown as AppState
}

function withLoginShell<T>(shell: string, run: () => T): T {
  clientLoginShell.value = shell
  try {
    return run()
  } finally {
    clientLoginShell.value = ''
  }
}

describe('resolveAiVaultResumeStartupShell', () => {
  it('reports the fish dialect for a local session under a fish login shell', () => {
    expect(
      withLoginShell('/opt/homebrew/bin/fish', () =>
        resolveAiVaultResumeStartupShell({
          state: makeState(),
          worktreeId: 'repo-1::worktree-1',
          platform: 'darwin',
          isLocalSession: true,
          parsedByClientLoginShell: true
        })
      )
    ).toBe('fish')
  })

  it('stays on sh for zsh users', () => {
    expect(
      withLoginShell('/bin/zsh', () =>
        resolveAiVaultResumeStartupShell({
          state: makeState(),
          worktreeId: 'repo-1::worktree-1',
          platform: 'darwin',
          isLocalSession: true,
          parsedByClientLoginShell: true
        })
      )
    ).toBe('posix')
  })

  it('stays on sh for a LOCAL session whose command a remote host parses', () => {
    // The reachable case: a locally scanned session has no executionHostId, so
    // isLocalSession stays true while the command is bound for an SSH host.
    expect(
      withLoginShell('/opt/homebrew/bin/fish', () =>
        resolveAiVaultResumeStartupShell({
          state: makeState(),
          worktreeId: 'repo-1::worktree-1',
          platform: 'linux',
          isLocalSession: true,
          parsedByClientLoginShell: false
        })
      )
    ).toBe('posix')
  })
})

describe('copied real-home Codex resume command', () => {
  const session = {
    agent: 'codex' as const,
    sessionId: 'session one',
    cwd: '/home/alice/repo',
    codexHome: null
  }

  it('clears inherited Codex homes with fish syntax under a fish login shell', () => {
    expect(
      withLoginShell('/opt/homebrew/bin/fish', () =>
        buildAiVaultResumeCopyCommandForWorktree({
          state: makeState(),
          worktreeId: 'repo-1::worktree-1',
          session
        })
      )
    ).toBe(
      "set -e CODEX_HOME; set -e ORCA_CODEX_HOME; cd '/home/alice/repo' && codex 'resume' 'session one'"
    )
  })

  it('keeps `unset` when a fish client targets an SSH worktree', () => {
    // The session was scanned locally (no executionHostId), but the worktree lives
    // on an SSH host: `set -e CODEX_HOME` would enable errexit there, not clear it.
    expect(
      withLoginShell('/opt/homebrew/bin/fish', () =>
        buildAiVaultResumeCopyCommandForWorktree({
          state: makeState('ssh:target-1'),
          worktreeId: 'repo-1::worktree-1',
          session
        })
      )
    ).toBe(
      "unset CODEX_HOME; unset ORCA_CODEX_HOME; cd '/home/alice/repo' && codex 'resume' 'session one'"
    )
  })

  it('keeps `unset` for sh-family login shells', () => {
    expect(
      withLoginShell('/bin/bash', () =>
        buildAiVaultResumeCopyCommandForWorktree({
          state: makeState(),
          worktreeId: 'repo-1::worktree-1',
          session
        })
      )
    ).toBe(
      "unset CODEX_HOME; unset ORCA_CODEX_HOME; cd '/home/alice/repo' && codex 'resume' 'session one'"
    )
  })
})
