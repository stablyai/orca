import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { buildAiVaultResumeCommand } from '../../../shared/ai-vault-types'
import {
  buildAiVaultResumeCommandForWorktree,
  buildAiVaultResumeStartupForWorktree,
  getAiVaultResumePlatform
} from './ai-vault-resume-command'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

type RuntimePreference = { kind: 'windows-host' } | { kind: 'wsl'; distro: string }

type AiVaultResumeCommandState = Pick<
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

function makeState(args: {
  worktreePath: string
  localWindowsRuntimePreference?: RuntimePreference
  terminalWindowsShell?: string
}): AiVaultResumeCommandState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::worktree-1',
    folderWorkspaces: [],
    projectGroups: [],
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
    settings: {
      localWindowsRuntimeDefault: { kind: 'windows-host' },
      ...(args.terminalWindowsShell ? { terminalWindowsShell: args.terminalWindowsShell } : {}),
      agentDefaultArgs: { claude: '', codex: '' },
      agentDefaultEnv: { claude: {}, codex: {} }
    },
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'repo-1::worktree-1',
          repoId: 'repo-1',
          path: args.worktreePath
        }
      ]
    }
  } as unknown as AiVaultResumeCommandState
}

describe('ai vault resume command runtime', () => {
  it('queues a PowerShell-valid command for the default Windows shell', () => {
    // Why: the queued command is typed into the live tab shell (default
    // PowerShell), which mis-parses the cmd `""`-doubled wrapper (#6152).
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
    ).toBe("Set-Location -LiteralPath 'C:\\Users\\alice\\repo'; claude '--resume' 'session one'")
  })

  it('keeps the cmd wrapper when the configured Windows shell is cmd.exe', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      terminalWindowsShell: 'cmd.exe'
    })

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
    ).toBe('cmd /d /s /c "cd /d ""C:\\Users\\alice\\repo"" && claude ""--resume"" ""session one"""')
  })

  it('queues a POSIX command for the Git Bash Windows shell', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      terminalWindowsShell: 'git-bash'
    })

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
    ).toBe("cd 'C:\\Users\\alice\\repo' && claude '--resume' 'session one'")
  })

  it('queues a PowerShell-valid local OMP resume by absolute transcript path', () => {
    // Regression: local rebuilds must forward session.filePath so OMP resumes by
    // path, and queued Windows commands must match the live tab shell.
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })

    const command = buildAiVaultResumeCommandForWorktree({
      state,
      worktreeId: 'repo-1::worktree-1',
      session: {
        agent: 'omp',
        sessionId: '019f27cd-4268-7000-96e7-62f42a55c144',
        filePath: 'C:\\Users\\alice\\.omp\\agent\\sessions\\repo\\sess.jsonl',
        cwd: 'C:\\Users\\alice\\repo',
        codexHome: null
      }
    })

    expect(command).toBe(
      "Set-Location -LiteralPath 'C:\\Users\\alice\\repo'; omp --resume 'C:\\Users\\alice\\.omp\\agent\\sessions\\repo\\sess.jsonl'"
    )
    expect(command).not.toContain('019f27cd-4268-7000-96e7-62f42a55c144')
  })

  it('keeps cmd quoting for local OMP resume when cmd.exe is configured', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      terminalWindowsShell: 'cmd.exe'
    })

    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'omp',
          sessionId: '019f27cd-4268-7000-96e7-62f42a55c144',
          filePath: 'C:\\Users\\alice\\.omp\\agent\\sessions\\repo\\sess.jsonl',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe(
      'cmd /d /s /c "cd /d ""C:\\Users\\alice\\repo"" && omp --resume ""C:\\Users\\alice\\.omp\\agent\\sessions\\repo\\sess.jsonl"""'
    )
  })

  it('keeps the cmd wrapper for the copy-to-clipboard command on Windows', () => {
    // Regression guard: the copy path is self-contained for pasting into cmd.exe
    // and must stay cmd-wrapped even though the queued path now follows the shell.
    expect(
      buildAiVaultResumeCommand({
        agent: 'claude',
        sessionId: 'session one',
        cwd: 'C:\\Users\\alice\\repo',
        platform: 'win32',
        codexHome: null
      })
    ).toBe('cmd /d /s /c "cd /d ""C:\\Users\\alice\\repo"" && claude --resume ""session one"""')
  })

  it('uses configured agent defaults for resumable session history entries', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })
    state.settings = {
      ...state.settings,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions --effort max' },
      agentDefaultEnv: { claude: { ANTHROPIC_BASE_URL: 'https://claude.example.test' } }
    } as never

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'claude',
          sessionId: 'session-1',
          cwd: '/home/alice/repo',
          codexHome: null
        }
      })
    ).toEqual({
      command:
        "cd '/home/alice/repo' && claude '--dangerously-skip-permissions' '--effort' 'max' '--resume' 'session-1'",
      env: { ANTHROPIC_BASE_URL: 'https://claude.example.test' },
      launchConfig: {
        agentCommand: "claude '--dangerously-skip-permissions' '--effort' 'max'",
        agentArgs: '--dangerously-skip-permissions --effort max',
        agentEnv: { ANTHROPIC_BASE_URL: 'https://claude.example.test' }
      }
    })
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
    ).toBe("cd '/home/alice/repo' && claude '--resume' 'session one'")
  })

  it('uses POSIX command wrapping for SSH-owned worktrees on Windows clients', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

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
    ).toBe("cd '/home/alice/repo' && claude '--resume' 'session one'")
  })

  it('uses POSIX command wrapping for folder workspaces with their own SSH target', () => {
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Platform',
        folderPath: '/home/alice/platform',
        connectionId: 'folder-ssh'
      }
    ] as never
    state.projectGroups = [{ id: 'group-1', connectionId: null, executionHostId: null }] as never

    expect(getAiVaultResumePlatform(state, 'folder:folder-1')).toBe('linux')
    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'folder:folder-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: '/home/alice/platform',
          codexHome: null
        }
      })
    ).toBe("cd '/home/alice/platform' && claude '--resume' 'session one'")
  })

  it('uses POSIX command wrapping for WSL UNC folder workspaces on Windows clients', () => {
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Platform',
        folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\platform'
      }
    ] as never
    state.projectGroups = [{ id: 'group-1', connectionId: null, executionHostId: 'local' }] as never

    expect(getAiVaultResumePlatform(state, 'folder:folder-1')).toBe('linux')
    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'folder:folder-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: '/home/alice/platform',
          codexHome: null
        }
      })
    ).toBe("cd '/home/alice/platform' && claude '--resume' 'session one'")
  })

  it('keeps WSL UNC worktrees on POSIX command wrapping without an explicit override', () => {
    const state = makeState({
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
    })

    expect(getAiVaultResumePlatform(state, 'repo-1::worktree-1')).toBe('linux')
  })

  it('converts WSL UNC Codex homes before building Linux resume commands', () => {
    const state = makeState({
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
    })

    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
        }
      })
    ).toBe("cd '/home/alice/repo' && CODEX_HOME='/home/alice/.codex' codex 'resume' 'session one'")
  })

  it('returns the remote resume command verbatim for non-local host sessions', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: null,
          executionHostId: 'ssh:dev-box',
          resumeCommand: "CODEX_HOME='/root/.codex' codex resume 'session one'"
        }
      })
    ).toEqual({ command: "CODEX_HOME='/root/.codex' codex resume 'session one'" })
  })

  it('bypasses the resume pipeline even when the command override is blank', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        commandOverride: '   ',
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: null,
          executionHostId: 'ssh:dev-box',
          resumeCommand: "CODEX_HOME='/root/.codex' codex resume 'session one'"
        }
      })
    ).toBe("CODEX_HOME='/root/.codex' codex resume 'session one'")
  })

  it('rebuilds the command when a non-blank override is supplied for a remote session', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        commandOverride: 'my-codex',
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: null,
          executionHostId: 'ssh:dev-box',
          resumeCommand: "CODEX_HOME='/root/.codex' codex resume 'session one'"
        }
      })
    ).toBe("cd '/home/alice/repo' && my-codex 'resume' 'session one'")
  })

  it('rebuilds overridden remote commands with the recorded remote host platform', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        commandOverride: 'my-codex',
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: 'C:/Users/alice/repo',
          codexHome: 'C:/Users/alice/.codex',
          executionHostId: 'ssh:win-box',
          executionHostPlatform: 'win32',
          resumeCommand:
            'cmd /d /s /c "cd /d ""C:/Users/alice/repo"" && set ""CODEX_HOME=C:/Users/alice/.codex"" && codex resume ""session one"""'
        }
      })
    ).toBe(
      "Set-Location -LiteralPath 'C:/Users/alice/repo'; $env:CODEX_HOME='C:/Users/alice/.codex'; my-codex 'resume' 'session one'"
    )
  })

  it('ignores a stored resume command for local-host sessions', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildAiVaultResumeCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: null,
          executionHostId: 'local',
          resumeCommand: "CODEX_HOME='/root/.codex' codex resume 'session one'"
        }
      })
    ).toBe("cd '/home/alice/repo' && codex 'resume' 'session one'")
  })
})
