import { getDefaultSettings } from '../../../shared/constants'
import { TEST_REPO, makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

import { buildAiVaultResumeCopyCommandForWorktree } from './ai-vault-resume-command'

type ResumeShellState = Parameters<typeof buildAiVaultResumeCopyCommandForWorktree>[0]['state']

function makeState(worktreeHostId?: `ssh:${string}`): ResumeShellState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::worktree-1',
    detectedWorktreesByRepo: {},
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ ...TEST_REPO, id: 'repo-1', path: '/home/alice/repo' }],
    projects: [
      {
        displayName: 'repo',
        badgeColor: '',
        createdAt: 0,
        updatedAt: 0,
        id: 'repo-1',
        sourceRepoIds: ['repo-1']
      }
    ],
    settings: {
      ...getDefaultSettings('/tmp'),
      agentDefaultArgs: { codex: '' },
      agentDefaultEnv: { codex: {} }
    },
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: 'repo-1::worktree-1',
          repoId: 'repo-1',
          path: '/home/alice/repo',
          ...(worktreeHostId ? { hostId: worktreeHostId } : {})
        })
      ]
    }
  }
}

describe('copied real-home Codex resume command', () => {
  const session = {
    agent: 'codex' as const,
    sessionId: 'session one',
    cwd: '/home/alice/repo',
    codexHome: null
  }

  it('clears inherited Codex homes for a worktree on an SSH host', () => {
    expect(
      buildAiVaultResumeCopyCommandForWorktree({
        state: makeState('ssh:target-1'),
        worktreeId: 'repo-1::worktree-1',
        session
      })
    ).toBe(
      `cd '/home/alice/repo' && env -u CODEX_HOME -u ORCA_CODEX_HOME codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'`
    )
  })
})
