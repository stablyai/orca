import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktreeAsync,
  buildAiVaultResumeStartupForWorktree
} from './ai-vault-resume-command'
import { runtimePathExists } from '@/runtime/runtime-file-metadata-client'

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('@/runtime/runtime-file-metadata-client', () => ({
  runtimePathExists: vi.fn()
}))

function makeState(args: {
  worktreePath: string
}): Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
> {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::worktree-1',
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ id: 'repo-1', path: args.worktreePath }],
    projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
    settings: {
      localWindowsRuntimeDefault: { kind: 'windows-host' },
      agentDefaultArgs: { claude: '', codex: '' },
      agentDefaultEnv: { claude: {}, codex: {} }
    },
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::worktree-1', repoId: 'repo-1', path: args.worktreePath }]
    }
  } as unknown as Pick<
    AppState,
    | 'activeRepoId'
    | 'activeWorktreeId'
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'projects'
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
  >
}

describe('ai vault resume cwd repinning', () => {
  it('falls back to the selected target when the recorded worktree cwd is gone', () => {
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\replacement' })
    const session = {
      agent: 'claude' as const,
      sessionId: 'session one',
      cwd: 'C:\\Users\\alice\\deleted',
      codexHome: null
    }

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session
      })
    ).toMatchObject({ cwd: 'C:\\Users\\alice\\replacement' })
    const command = buildAiVaultResumeCopyCommandForWorktree({
      state,
      worktreeId: 'repo-1::worktree-1',
      session
    })
    expect(command).toContain('replacement')
    expect(command).not.toContain('deleted')
  })

  it('preserves a valid session subdirectory under the selected target', () => {
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })
    const session = {
      agent: 'claude' as const,
      sessionId: 'session one',
      cwd: 'C:\\Users\\alice\\repo\\packages\\app',
      codexHome: null
    }

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session
      })
    ).toMatchObject({ cwd: session.cwd })
    expect(
      buildAiVaultResumeCopyCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session
      })
    ).toContain('packages')
  })

  it('uses the folder target path when a folder session source is unavailable', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Platform',
        folderPath: '/home/alice/platform'
      }
    ] as never

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'folder:folder-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: '/home/alice/deleted-folder',
          codexHome: null
        }
      })
    ).toMatchObject({ cwd: '/home/alice/platform' })
  })

  it('repins a remote resume to the selected workspace without local filesystem access', () => {
    const state = makeState({ worktreePath: '/home/alice/replacement' })
    state.repos = [
      { id: 'repo-1', path: '/home/alice/replacement', connectionId: 'ssh-1' }
    ] as never
    const session = {
      agent: 'claude' as const,
      sessionId: 'session one',
      cwd: '/home/alice/deleted',
      codexHome: null,
      executionHostId: 'ssh:dev-box' as const,
      executionHostPlatform: 'linux' as const,
      resumeCommand: "cd '/home/alice/deleted' && claude '--resume' 'session one'"
    }

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session
      })
    ).toMatchObject({ cwd: '/home/alice/replacement' })
    expect(
      buildAiVaultResumeCopyCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session
      })
    ).toBe("cd '/home/alice/replacement' && claude '--resume' 'session one'")
    expect(
      buildAiVaultResumeStartupForWorktree({ state, worktreeId: 'repo-1::worktree-1', session })
    ).toMatchObject({ command: "claude '--resume' 'session one'", cwd: '/home/alice/replacement' })
  })

  it('repins a Windows remote scanner command without nesting cmd in PowerShell', () => {
    const state = makeState({ worktreePath: 'C:\\healthy\\repo' })
    state.repos = [{ id: 'repo-1', path: 'C:\\healthy\\repo', connectionId: 'ssh-1' }] as never
    const session = {
      agent: 'cline' as const,
      sessionId: 'session one',
      cwd: 'C:/deleted/repo',
      codexHome: null,
      executionHostId: 'ssh:windows-box' as const,
      executionHostPlatform: 'win32' as const,
      resumeCommand: 'cmd /d /s /c "cd /d ""C:/deleted/repo"" && cline --id ""session one"""'
    }

    const startup = buildAiVaultResumeStartupForWorktree({
      state,
      worktreeId: 'repo-1::worktree-1',
      session
    })
    expect(startup).toMatchObject({ cwd: 'C:\\healthy\\repo' })
    expect(startup.command).toBe('cline --id "session one"')
    expect(startup.command).not.toContain('C:/deleted/repo')
    expect(
      buildAiVaultResumeCopyCommandForWorktree({ state, worktreeId: 'repo-1::worktree-1', session })
    ).toContain('C:\\healthy\\repo')
    expect(
      buildAiVaultResumeCopyCommandForWorktree({ state, worktreeId: 'repo-1::worktree-1', session })
    ).toContain('cmd /d /s /c')
  })

  it('returns a Linux cwd when a valid WSL session is nested under the target', () => {
    const state = makeState({
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
    })
    const session = {
      agent: 'claude' as const,
      sessionId: 'session one',
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\packages\\app',
      codexHome: null
    }

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session
      })
    ).toMatchObject({ cwd: '/home/alice/repo/packages/app' })
  })

  it('does not propagate a session cwd when the selected workspace path is unavailable', () => {
    const state = makeState({ worktreePath: '/home/alice/unused' })
    const session = {
      agent: 'claude' as const,
      sessionId: 'session one',
      cwd: '/home/alice/deleted',
      codexHome: null,
      executionHostId: 'ssh:dev-box' as const,
      executionHostPlatform: 'linux' as const,
      resumeCommand: "cd '/home/alice/deleted' && claude '--resume' 'session one'"
    }
    expect(
      buildAiVaultResumeStartupForWorktree({ state, worktreeId: 'missing', session })
    ).toMatchObject({ command: "claude '--resume' 'session one'" })
  })

  it('treats an outside runtime-owned session cwd as unavailable instead of throwing', async () => {
    const state = makeState({ worktreePath: '/home/alice/replacement' })
    state.settings = {
      ...state.settings,
      activeRuntimeEnvironmentId: 'runtime-1'
    } as never
    state.worktreesByRepo = {
      'repo-1': [
        {
          id: 'repo-1::worktree-1',
          repoId: 'repo-1',
          path: '/home/alice/replacement',
          runtimeOwnerEnvironmentId: 'runtime-1'
        }
      ]
    } as never
    const session = {
      agent: 'claude' as const,
      sessionId: 'session one',
      cwd: '/home/alice/deleted',
      codexHome: null,
      executionHostId: 'runtime:runtime-1' as const,
      executionHostPlatform: 'linux' as const,
      resumeCommand: "cd '/home/alice/deleted' && claude '--resume' 'session one'"
    }

    await expect(
      buildAiVaultResumeStartupForWorktreeAsync({
        state,
        worktreeId: 'repo-1::worktree-1',
        session
      })
    ).resolves.toMatchObject({
      command: "claude '--resume' 'session one'",
      cwd: '/home/alice/replacement'
    })
    expect(runtimePathExists).not.toHaveBeenCalled()
  })
})
