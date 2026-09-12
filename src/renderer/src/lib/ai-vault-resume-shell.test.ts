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
  // Why no login-shell cases: the Unix branch emits quoting and env clearing that
  // are correct in sh and fish alike, so it no longer probes $SHELL at all — see
  // startup-shell-portability.live-shell.test.ts for the proof it holds.
  it.each(['/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash'])(
    'reports one Unix dialect regardless of the login shell (%s)',
    (loginShell) => {
      expect(
        withLoginShell(loginShell, () =>
          resolveAiVaultResumeStartupShell({
            state: makeState(),
            worktreeId: 'repo-1::worktree-1',
            platform: 'darwin',
            isLocalSession: true
          })
        )
      ).toBe('posix')
    }
  )

  it('stays on the Unix dialect for a LOCAL session whose command a remote host parses', () => {
    expect(
      withLoginShell('/opt/homebrew/bin/fish', () =>
        resolveAiVaultResumeStartupShell({
          state: makeState(),
          worktreeId: 'repo-1::worktree-1',
          platform: 'linux',
          isLocalSession: true
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

  it('clears inherited Codex homes for a worktree on an SSH host', () => {
    expect(
      withLoginShell('/opt/homebrew/bin/fish', () =>
        buildAiVaultResumeCopyCommandForWorktree({
          state: makeState('ssh:target-1'),
          worktreeId: 'repo-1::worktree-1',
          session
        })
      )
    ).toBe(
      `cd '/home/alice/repo' && env -u CODEX_HOME -u ORCA_CODEX_HOME codex 'resume' 'session one'`
    )
  })

  it('emits the same self-contained teardown under an sh-family login shell', () => {
    // Why identical to the fish case: this text is COPIED, so it may be pasted
    // into any shell — it carries its own fish/sh branch instead of guessing.
    expect(
      withLoginShell('/bin/bash', () =>
        buildAiVaultResumeCopyCommandForWorktree({
          state: makeState(),
          worktreeId: 'repo-1::worktree-1',
          session
        })
      )
    ).toBe(
      `cd '/home/alice/repo' && env -u CODEX_HOME -u ORCA_CODEX_HOME codex 'resume' 'session one'`
    )
  })
})
