import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  getAiVaultAgentProviderSession,
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree
} from './ai-vault-resume-command'
import { dropDeletedSshResumeCwd } from './ai-vault-session-resume-preparation'

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

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

function buildQueuedAiVaultResumeCommand(
  args: Parameters<typeof buildAiVaultResumeStartupForWorktree>[0]
): string {
  return buildAiVaultResumeStartupForWorktree(args).command
}

describe('ai vault resume command runtime', () => {
  it.each(['local', 'ssh:reference-host'] as const)(
    'starts a fresh IDE reference on %s with model and environment preserved',
    (executionHostId) => {
      const state = makeState({
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\example\\project',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
      if (executionHostId !== 'local') {
        state.repos = state.repos.map((repo) => ({ ...repo, executionHostId }))
      }
      const session = {
        agent: 'antigravity' as const,
        sessionId: 'ide-id',
        cwd: '/home/example/project',
        codexHome: null,
        executionHostId,
        executionHostPlatform: 'linux' as const,
        resumeCommand: 'agy --conversation ide-id',
        filePath:
          executionHostId === 'local'
            ? '\\\\wsl.localhost\\Ubuntu\\home\\example\\.gemini\\antigravity-ide\\brain\\ide-id\\.system_generated\\logs\\transcript_full.jsonl'
            : '/home/example/.gemini/antigravity-ide/brain/ide-id/.system_generated/logs/transcript_full.jsonl'
      }
      if (!state.settings) {
        throw new Error('Missing fixture settings')
      }
      state.settings.agentDefaultArgs = { antigravity: '--model claude-sonnet-4-6' }
      state.settings.agentDefaultEnv = { antigravity: { AGY_CLI_HIDE_ACCOUNT_INFO: '1' } }
      const startup = buildAiVaultResumeStartupForWorktree({ state, session })
      expect(startup.command).toContain('--prompt-interactive')
      expect(startup.command).not.toContain('--conversation')
      expect(startup.command).not.toContain('wsl.localhost')
      expect(startup.command).toContain('--model')
      expect(startup.command).toContain('claude-sonnet-4-6')
      expect(startup.env).toMatchObject({ AGY_CLI_HIDE_ACCOUNT_INFO: '1' })
      expect(startup.providerSession).toBeUndefined()
      expect(getAiVaultAgentProviderSession(session)).toBeNull()
      expect(startup.cwd).toBe('/home/example/project')
    }
  )

  it('repro: queues a host-runtime resume without configured-WSL shell syntax', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      localWindowsRuntimePreference: { kind: 'windows-host' },
      terminalWindowsShell: 'wsl.exe'
    })

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toMatchObject({
      command: "claude '--resume' 'session one'",
      cwd: 'C:\\Users\\alice\\repo'
    })
  })

  it('queues a PowerShell-valid command for the default Windows shell', () => {
    // Why: the queued command is typed into the live tab shell (default
    // PowerShell), which mis-parses the cmd `""`-doubled wrapper (#6152).
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })

    expect(
      buildQueuedAiVaultResumeCommand({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe("claude '--resume' 'session one'")
  })

  it('queues direct cmd syntax when the configured Windows shell is cmd.exe', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      terminalWindowsShell: 'cmd.exe'
    })

    expect(
      buildQueuedAiVaultResumeCommand({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe('claude "--resume" "session one"')
  })

  it('queues a POSIX command for the Git Bash Windows shell', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      terminalWindowsShell: 'git-bash'
    })

    expect(
      buildQueuedAiVaultResumeCommand({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe("claude '--resume' 'session one'")
  })

  it('follows the live Windows shell for Cursor resume', () => {
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })

    expect(
      buildQueuedAiVaultResumeCommand({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'cursor',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe("cursor-agent '--yolo' '--resume' 'session one'")
  })

  it('queues a PowerShell-valid local OMP resume by absolute transcript path', () => {
    // Regression: local rebuilds must forward session.filePath so OMP resumes by
    // path, and queued Windows commands must match the live tab shell.
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })

    const command = buildQueuedAiVaultResumeCommand({
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

    expect(command).toBe("omp --resume 'C:\\Users\\alice\\.omp\\agent\\sessions\\repo\\sess.jsonl'")
    expect(command).not.toContain('019f27cd-4268-7000-96e7-62f42a55c144')
  })

  it('queues a direct local OMP resume when cmd.exe is configured', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      terminalWindowsShell: 'cmd.exe'
    })

    expect(
      buildQueuedAiVaultResumeCommand({
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
    ).toBe('omp --resume "C:\\Users\\alice\\.omp\\agent\\sessions\\repo\\sess.jsonl"')
  })

  it('copies syntax that matches the configured cmd shell', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      terminalWindowsShell: 'cmd.exe'
    })

    expect(
      buildAiVaultResumeCopyCommandForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'claude',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe('cd /d "C:\\Users\\alice\\repo" && claude "--resume" "session one"')
  })

  it('copies syntax that matches the configured PowerShell shell', () => {
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })

    expect(
      buildAiVaultResumeCopyCommandForWorktree({
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

  it('copies a real-home Codex command that clears inherited homes in PowerShell', () => {
    const state = makeState({ worktreePath: 'C:\\Users\\alice\\repo' })

    expect(
      buildAiVaultResumeCopyCommandForWorktree({
        state,
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe(
      "Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue; Remove-Item Env:ORCA_CODEX_HOME -ErrorAction SilentlyContinue; Set-Location -LiteralPath 'C:\\Users\\alice\\repo'; codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'"
    )
  })

  it('copies a real-home Codex command that clears inherited homes in cmd', () => {
    const state = makeState({
      worktreePath: 'C:\\Users\\alice\\repo',
      terminalWindowsShell: 'cmd.exe'
    })

    expect(
      buildAiVaultResumeCopyCommandForWorktree({
        state,
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: 'C:\\Users\\alice\\repo',
          codexHome: null
        }
      })
    ).toBe(
      'set "CODEX_HOME=" & set "ORCA_CODEX_HOME=" & cd /d "C:\\Users\\alice\\repo" && codex "-c" "tui.resume_cwd=current" "resume" "session one"'
    )
  })

  it('copies a real-home Codex command that clears inherited homes in POSIX shells', () => {
    const state = makeState({
      worktreePath: '/home/alice/repo',
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(
      buildAiVaultResumeCopyCommandForWorktree({
        state,
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: null
        }
      })
    ).toBe(
      `cd '/home/alice/repo' && env -u CODEX_HOME -u ORCA_CODEX_HOME codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'`
    )
  })

  it('keeps copied custom-home Codex commands pinned to that home', () => {
    const state = makeState({
      worktreePath: '/home/alice/repo',
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const command = buildAiVaultResumeCopyCommandForWorktree({
      state,
      session: {
        agent: 'codex',
        sessionId: 'session one',
        cwd: '/home/alice/repo',
        codexHome: '/home/alice/custom-codex'
      }
    })

    expect(command).toBe(
      "cd '/home/alice/repo' && CODEX_HOME='/home/alice/custom-codex' codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'"
    )
    expect(command).not.toContain('unset CODEX_HOME')
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
      command: "claude '--dangerously-skip-permissions' '--effort' 'max' '--resume' 'session-1'",
      cwd: '/home/alice/repo',
      env: { ANTHROPIC_BASE_URL: 'https://claude.example.test' },
      launchConfig: {
        agentCommand: "claude '--dangerously-skip-permissions' '--effort' 'max'",
        agentArgs: '--dangerously-skip-permissions --effort max',
        agentEnv: { ANTHROPIC_BASE_URL: 'https://claude.example.test' }
      },
      providerSession: { key: 'session_id', id: 'session-1' }
    })
  })

  it('converts WSL UNC Codex homes before building Linux resume commands', () => {
    const state = makeState({
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
    })

    expect(
      buildQueuedAiVaultResumeCommand({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
        }
      })
    ).toBe(
      "CODEX_HOME='/home/alice/.codex' codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'"
    )
  })

  it('converts WSL UNC OMP transcript paths before building Linux resume commands', () => {
    const state = makeState({
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
    })

    expect(
      buildQueuedAiVaultResumeCommand({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'omp',
          sessionId: '019f27cd-4268-7000-96e7-62f42a55c144',
          filePath:
            '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.omp\\agent\\sessions\\repo\\sess.jsonl',
          cwd: '/home/alice/repo',
          codexHome: null
        }
      })
    ).toBe("omp --resume '/home/alice/.omp/agent/sessions/repo/sess.jsonl'")
  })

  it('deletes inherited Codex homes when resuming a real-home session', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })

    expect(
      buildAiVaultResumeStartupForWorktree({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'codex',
          sessionId: 'session one',
          cwd: '/home/alice/repo',
          codexHome: null
        }
      })
    ).toMatchObject({
      command: "codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'",
      cwd: '/home/alice/repo',
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME']
    })
  })

  it('resumes an SSH session at the workspace root once the host reports its folder deleted', async () => {
    const pathExists = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', { api: { fs: { pathExists } } })
    const session = {
      agent: 'codex' as const,
      sessionId: 'session one',
      cwd: '/home/alice/wt/feat-x',
      codexHome: '/home/alice/.codex',
      executionHostId: 'ssh:dev-box' as const,
      executionHostPlatform: 'linux' as const,
      resumeCommand:
        "cd '/home/alice/wt/feat-x' && CODEX_HOME='/home/alice/.codex' codex resume 'session one'"
    }

    const startup = buildAiVaultResumeStartupForWorktree({
      state: makeState({ worktreePath: '/home/alice/wt/main' }),
      worktreeId: 'repo-1::worktree-1',
      session: await dropDeletedSshResumeCwd(session)
    })

    // Why: typing `cd <deleted folder> && …` into the SSH shell stopped the agent, and Codex
    // resumed at the root would still prompt with the deleted folder preselected (#17745).
    expect(startup.command).not.toContain('feat-x')
    expect(startup.command).toContain("'-c' 'tui.resume_cwd=current' 'resume'")
    expect(startup.cwd).toBeUndefined()
    expect(pathExists).toHaveBeenCalledWith({
      filePath: '/home/alice/wt/feat-x',
      connectionId: 'dev-box'
    })
  })

  it('rebuilds remote real-home Codex commands without a stored home assignment', () => {
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
    ).toMatchObject({
      command: "codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'",
      cwd: '/home/alice/repo',
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      providerSession: { key: 'session_id', id: 'session one' }
    })
  })

  it('rebuilds remote real-home Codex commands when the override is blank', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildQueuedAiVaultResumeCommand({
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
    ).toBe("codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'")
  })

  it('copies remote real-home Codex commands with explicit environment cleanup', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    const command = buildAiVaultResumeCopyCommandForWorktree({
      state,
      worktreeId: 'repo-1::worktree-1',
      session: {
        agent: 'codex',
        sessionId: 'session one',
        cwd: '/home/alice/repo',
        codexHome: null,
        executionHostId: 'runtime:env-1',
        executionHostPlatform: 'linux',
        resumeCommand: "CODEX_HOME='/retired/shared-home' codex resume 'session one'"
      }
    })

    expect(command).toBe(
      `cd '/home/alice/repo' && env -u CODEX_HOME -u ORCA_CODEX_HOME codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'`
    )
    expect(command).not.toContain('/retired/shared-home')
  })

  it('rebuilds the command when a non-blank override is supplied for a remote session', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildQueuedAiVaultResumeCommand({
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
    ).toBe("my-codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'")
  })

  it('rebuilds overridden remote commands with the recorded remote host platform', () => {
    const state = makeState({
      worktreePath: '/home/alice/repo',
      terminalWindowsShell: 'cmd.exe'
    })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildQueuedAiVaultResumeCommand({
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
      "$env:CODEX_HOME='C:/Users/alice/.codex'; my-codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'"
    )
  })

  it('applies the user default args to local Copilot AI Vault resumes', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.settings = { ...state.settings, agentDefaultArgs: { copilot: '--yolo' } } as never

    expect(
      buildQueuedAiVaultResumeCommand({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'copilot',
          sessionId: '940237d9-c712-48e8-bca1-fd75fc4a8d4b',
          cwd: '/home/alice/repo',
          codexHome: null
        }
      })
    ).toBe("copilot '--yolo' '--resume=940237d9-c712-48e8-bca1-fd75fc4a8d4b'")
  })

  it('keeps the scanner resume command for remote Copilot sessions', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildQueuedAiVaultResumeCommand({
        state,
        worktreeId: 'repo-1::worktree-1',
        session: {
          agent: 'copilot',
          sessionId: '940237d9-c712-48e8-bca1-fd75fc4a8d4b',
          cwd: '/home/alice/repo',
          codexHome: null,
          executionHostId: 'ssh:dev-box',
          resumeCommand: "copilot --resume='940237d9-c712-48e8-bca1-fd75fc4a8d4b'"
        }
      })
    ).toBe("copilot --resume='940237d9-c712-48e8-bca1-fd75fc4a8d4b'")
  })

  it('ignores a stored resume command for local-host sessions', () => {
    const state = makeState({ worktreePath: '/home/alice/repo' })
    state.repos = [{ id: 'repo-1', path: '/home/alice/repo', connectionId: 'ssh-1' }] as never

    expect(
      buildQueuedAiVaultResumeCommand({
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
    ).toBe("codex '-c' 'tui.resume_cwd=current' 'resume' 'session one'")
  })
})
