import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from './ai-vault-types'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import {
  buildMobileAiVaultResumeLaunch,
  buildMobileAiVaultResumeCommand,
  createMobileAiVaultResumeMutationRegistry,
  readMobileRuntimeTerminalWindowsShell,
  resolveMobileAiVaultResumePlatform
} from './mobile-ai-vault-resume-launch-plan'

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session 1',
    title: 'Resume me',
    cwd: '/Users/ada/repo',
    branch: 'main',
    model: null,
    filePath: '/Users/ada/.claude/session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-06-29T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

describe('buildMobileAiVaultResumeCommand', () => {
  it('delegates POSIX command construction to the shared AI Vault builder', () => {
    expect(buildMobileAiVaultResumeCommand({ session: session(), hostPlatform: 'darwin' })).toBe(
      "cd '/Users/ada/repo' && claude --resume 'session 1'"
    )
  })

  it('uses PowerShell-safe queued command construction for default local Windows terminals', () => {
    expect(
      buildMobileAiVaultResumeCommand({
        session: session({
          agent: 'codex',
          sessionId: 'codex-1',
          cwd: 'C:\\repo app',
          codexHome: 'C:\\Users\\Ada\\.codex'
        }),
        hostPlatform: 'win32'
      })
    ).toBe(
      "Set-Location -LiteralPath 'C:\\repo app'; $env:CODEX_HOME='C:\\Users\\Ada\\.codex'; codex resume 'codex-1'"
    )
  })

  it('resumes OMP sessions by absolute transcript path like desktop', () => {
    // Regression: custom OMP_CODING_AGENT_DIR / WSL-store sessions miss on an
    // id lookup, so the forwarded filePath must win over the session id.
    expect(
      buildMobileAiVaultResumeCommand({
        session: session({
          agent: 'omp',
          sessionId: '019f27cd-4268-7000-96e7-62f42a55c144',
          filePath: '/Users/ada/.omp/agent/sessions/repo/sess.jsonl',
          cwd: '/Users/ada/repo'
        }),
        hostPlatform: 'darwin'
      })
    ).toBe("cd '/Users/ada/repo' && omp --resume '/Users/ada/.omp/agent/sessions/repo/sess.jsonl'")
  })

  it('uses direct cmd syntax when the host Windows terminal is already cmd', () => {
    // Why: resume text is typed into the live host tab. Nested `cmd /d /s /c`
    // wrappers break interactive cmd quoting (see buildAiVaultResumeShellCommand).
    const command = buildMobileAiVaultResumeCommand({
      session: session({
        agent: 'codex',
        sessionId: 'codex-1',
        cwd: 'C:\\repo app',
        codexHome: 'C:\\Users\\Ada\\.codex'
      }),
      hostPlatform: 'win32',
      hostTerminalWindowsShell: 'cmd.exe'
    })
    expect(command).toBe(
      'cd /d "C:\\repo app" && set "CODEX_HOME=C:\\Users\\Ada\\.codex" && codex resume "codex-1"'
    )
  })

  it('uses POSIX command construction and converts Codex home for WSL targets', () => {
    expect(
      buildMobileAiVaultResumeCommand({
        session: session({
          agent: 'codex',
          sessionId: 'codex-1',
          cwd: '/home/ada/repo',
          codexHome: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex'
        }),
        hostPlatform: 'linux'
      })
    ).toBe("cd '/home/ada/repo' && CODEX_HOME='/home/ada/.codex' codex resume 'codex-1'")
  })

  it('passes command overrides through to the shared builder', () => {
    expect(
      buildMobileAiVaultResumeCommand({
        session: session({ sessionId: 'abc' }),
        hostPlatform: 'linux',
        commandOverride: 'claude-dev'
      })
    ).toBe("cd '/Users/ada/repo' && claude-dev --resume 'abc'")
  })
})

describe('buildMobileAiVaultResumeLaunch', () => {
  it('routes Kimi through the resumable-agent startup plan', () => {
    // Why: kimi joining RESUMABLE_TUI_AGENTS moves it off the plain command fallback, so the
    // cd prefix Kimi needs (sessions are work-dir-scoped) must survive the new branch.
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({
        agent: 'kimi',
        sessionId: 'session_431324d7-2165-42f0-9ecd-9f93437b3201'
      }),
      hostPlatform: 'darwin'
    })

    expect(launch).toMatchObject({
      command:
        "cd '/Users/ada/repo' && kimi '--yolo' '--session' 'session_431324d7-2165-42f0-9ecd-9f93437b3201'",
      launchConfig: { agentCommand: "kimi '--yolo'" },
      launchAgent: 'kimi'
    })
  })

  it('preserves an arbitrary OMP transcript locator for later cold resume', () => {
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({
        agent: 'omp',
        sessionId: 'omp-custom-1',
        filePath: '/custom/omp-sessions/project/session.jsonl'
      }),
      hostPlatform: 'linux',
      settings: {
        agentDefaultArgs: { omp: '--model custom' },
        agentDefaultEnv: { omp: { OMP_PROFILE: 'custom' } }
      }
    })

    expect(launch).toMatchObject({
      command:
        "cd '/Users/ada/repo' && omp '--model' 'custom' --resume '/custom/omp-sessions/project/session.jsonl'",
      env: { OMP_PROFILE: 'custom' },
      launchConfig: {
        agentCommand: "omp '--model' 'custom'",
        agentArgs: '--model custom',
        agentEnv: { OMP_PROFILE: 'custom' },
        ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
      },
      launchAgent: 'omp'
    })

    const coldLaunch = buildAgentResumeStartupPlan({
      agent: 'omp',
      providerSession: { key: 'session_id', id: 'omp-custom-1' },
      cmdOverrides: {},
      agentArgs: launch.launchConfig?.agentArgs,
      agentEnv: launch.launchConfig?.agentEnv,
      agentCommand: launch.launchConfig?.agentCommand,
      ompResumeFilePath: launch.launchConfig?.ompResumeFilePath,
      platform: 'linux'
    })
    expect(coldLaunch).toMatchObject({
      launchCommand:
        "omp '--model' 'custom' '--resume' '/custom/omp-sessions/project/session.jsonl'",
      env: { OMP_PROFILE: 'custom' }
    })
  })

  it('uses shared TUI startup planning for default args, env, and launch config', () => {
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({
        agent: 'claude',
        sessionId: 'abc 123',
        cwd: '/Users/ada/repo'
      }),
      hostPlatform: 'darwin',
      settings: {
        agentCmdOverrides: { claude: 'claude-dev' },
        agentDefaultArgs: { claude: '--model opus' },
        agentDefaultEnv: { claude: { ANTHROPIC_BASE_URL: 'http://localhost:3000' } }
      }
    })
    expect(launch.command).toBe(
      "cd '/Users/ada/repo' && claude-dev '--model' 'opus' '--resume' 'abc 123'"
    )
    expect(launch.env).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:3000' })
    expect(launch.launchAgent).toBe('claude')
    expect(launch.launchConfig).toEqual({
      agentCommand: "claude-dev '--model' 'opus'",
      agentArgs: '--model opus',
      agentEnv: { ANTHROPIC_BASE_URL: 'http://localhost:3000' }
    })
    // Only bare real-home Codex resumes request env deletion.
    expect(launch.envToDelete).toBeUndefined()
  })

  it('deletes inherited Codex homes when resuming a real-home session like desktop', () => {
    // Regression: a user agentDefaultEnv CODEX_HOME (or a stale daemon-
    // inherited home) must not reroute a bare real-home resume typed into the
    // created pane; desktop already strips the pair at pane spawn.
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({ agent: 'codex', sessionId: 'codex-1', codexHome: null }),
      hostPlatform: 'darwin',
      settings: {
        agentDefaultEnv: { codex: { CODEX_HOME: '/Users/ada/.codex-pinned' } }
      }
    })
    expect(launch.command).not.toContain('CODEX_HOME=')
    expect(launch.envToDelete).toEqual(['CODEX_HOME', 'ORCA_CODEX_HOME'])
  })

  it('keeps managed-home Codex resumes free of env deletion', () => {
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({
        agent: 'codex',
        sessionId: 'codex-1',
        codexHome: '/Users/ada/.orca/codex-runtime-home/home'
      }),
      hostPlatform: 'darwin'
    })
    expect(launch.command).toContain("CODEX_HOME='/Users/ada/.orca/codex-runtime-home/home'")
    expect(launch.envToDelete).toBeUndefined()
  })
})

describe('createMobileAiVaultResumeMutationRegistry', () => {
  it('reuses the claimed id across retries until a success releases it', () => {
    let mints = 0
    const registry = createMobileAiVaultResumeMutationRegistry((sessionId) => {
      mints += 1
      return `${sessionId}:mutation-${mints}`
    })

    expect(registry.claim('session-a')).toBe('session-a:mutation-1')
    // A failed attempt keeps the key so the host can dedup the retry.
    expect(registry.claim('session-a')).toBe('session-a:mutation-1')

    registry.releaseOnSuccess('session-a')
    // A resume after success mints fresh so the user can fork intentionally.
    expect(registry.claim('session-a')).toBe('session-a:mutation-2')
  })

  it('tracks sessions independently', () => {
    const registry = createMobileAiVaultResumeMutationRegistry((sessionId) => `${sessionId}:id`)
    expect(registry.claim('session-a')).toBe('session-a:id')
    expect(registry.claim('session-b')).toBe('session-b:id')
    registry.releaseOnSuccess('session-b')
    expect(registry.claim('session-a')).toBe('session-a:id')
  })
})

describe('resume platform helpers', () => {
  it('reads the host Windows terminal shell from status.get', () => {
    expect(readMobileRuntimeTerminalWindowsShell({ terminalWindowsShell: 'wsl.exe' })).toBe(
      'wsl.exe'
    )
    expect(readMobileRuntimeTerminalWindowsShell({ terminalWindowsShell: '' })).toBeNull()
  })

  it('uses Linux/POSIX construction for SSH targets and host platform for local targets', () => {
    expect(resolveMobileAiVaultResumePlatform('ssh', 'win32')).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('local', 'darwin')).toBe('darwin')
    expect(
      resolveMobileAiVaultResumePlatform(
        'local',
        'win32',
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'
      )
    ).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('local', 'win32', 'C:\\repo', 'linux')).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('runtime', 'linux')).toBeNull()
  })
})
