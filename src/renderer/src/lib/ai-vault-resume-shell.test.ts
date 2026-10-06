import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))
vi.mock('@/lib/client-platform', () => ({ CLIENT_PLATFORM: 'darwin' }))

import { buildAiVaultResumeCopyCommandForWorktree } from './ai-vault-resume-command'

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
