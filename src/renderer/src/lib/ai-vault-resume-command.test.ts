import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  buildAiVaultResumeCommandForWorktree,
  getAiVaultResumePlatform
} from './ai-vault-resume-command'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

type RuntimePreference = { kind: 'windows-host' } | { kind: 'wsl'; distro: string }

function makeState(args: {
  worktreePath: string
  localWindowsRuntimePreference?: RuntimePreference
}): Pick<
  AppState,
  'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
> {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::worktree-1',
    repos: [{ id: 'repo-1', path: 'C:\\Users\\alice\\repo' }],
    projects: [
      {
        id: 'repo-1',
        sourceRepoIds: ['repo-1'],
        ...(args.localWindowsRuntimePreference
          ? { localWindowsRuntimePreference: args.localWindowsRuntimePreference }
          : {})
      }
    ],
    settings: { localWindowsRuntimeDefault: { kind: 'windows-host' } },
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'repo-1::worktree-1',
          repoId: 'repo-1',
          path: args.worktreePath
        }
      ]
    }
  } as unknown as Pick<
    AppState,
    'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
  >
}

describe('ai vault resume command runtime', () => {
  it('uses Windows command wrapping for Windows-host projects', () => {
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })

    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe('cmd /d /s /c "cd /d ""C:\\Users\\alice\\repo"" && claude --resume ""session one"""')
  })

  it('uses POSIX command wrapping for Windows-path projects forced to WSL', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(getAiVaultResumePlatform(state, 'repo-1::worktree-1')).toBe('linux')
    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: null
        }
      })
    ).toBe("cd '/home/alice/repo' && claude --resume 'session one'")
  })

  it('keeps WSL UNC worktrees on POSIX command wrapping without an explicit override', () => {
    const state = makeState({
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
    })

    expect(getAiVaultResumePlatform(state, 'repo-1::worktree-1')).toBe('linux')
  })
})
