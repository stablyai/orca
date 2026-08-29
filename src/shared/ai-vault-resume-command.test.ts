import { describe, expect, it } from 'vitest'

import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand
} from './ai-vault-resume-command'

describe('buildAiVaultResumeCommand', () => {
  it('uses Antigravity conversation ids instead of Gemini resume flags', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'antigravity',
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        cwd: '/repo/app',
        platform: 'darwin'
      })
    ).toBe("cd '/repo/app' && agy --conversation 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'")
  })

  it('builds a self-contained cmd wrapper when no live shell is known', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'codex',
        sessionId: 'session-1',
        cwd: 'C:\\Users\\Ada Lovelace\\repo',
        platform: 'win32'
      })
    ).toBe('cmd /d /s /c "cd /d ""C:\\Users\\Ada Lovelace\\repo"" && codex resume ""session-1"""')
  })

  it('builds a direct queued command for a live cmd shell', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'omp',
        sessionId: 'session-one',
        resumeFilePath: 'C:\\Users\\Ada Lovelace\\.omp\\sessions\\A&B session one.jsonl',
        cwd: 'C:\\Users\\Ada Lovelace\\A&B repo',
        platform: 'win32',
        shell: 'cmd'
      })
    ).toBe(
      'cd /d "C:\\Users\\Ada Lovelace\\A&B repo" && omp --resume "C:\\Users\\Ada Lovelace\\.omp\\sessions\\A&B session one.jsonl"'
    )
  })

  it('emits no CODEX_HOME stamp for real-home canonical sessions', () => {
    // Backfilled sessions dedupe to the real-home row (codexHome null); their
    // resume must run against the user's own ~/.codex, never the frozen
    // managed home whose auth.json stops refreshing after the flip.
    const command = buildAiVaultResumeCommand({
      agent: 'codex',
      sessionId: 'session-1',
      cwd: '/repo/app',
      platform: 'darwin',
      codexHome: null
    })
    expect(command).toBe("cd '/repo/app' && codex resume 'session-1'")
    expect(command).not.toContain('CODEX_HOME')
  })

  it('carries non-default Codex homes in copied resume commands', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'codex',
        sessionId: 'session-1',
        cwd: '/repo/app',
        platform: 'darwin',
        codexHome: '/Users/ada/Library/Application Support/Orca/codex-runtime-home/home'
      })
    ).toBe(
      "cd '/repo/app' && CODEX_HOME='/Users/ada/Library/Application Support/Orca/codex-runtime-home/home' codex resume 'session-1'"
    )

    expect(
      buildAiVaultResumeCommand({
        agent: 'codex',
        sessionId: 'session-1',
        cwd: 'C:\\Users\\Ada Lovelace\\repo',
        platform: 'win32',
        codexHome: 'C:\\Users\\Ada\\AppData\\Roaming\\Orca\\codex-runtime-home\\home'
      })
    ).toBe(
      'cmd /d /s /c "cd /d ""C:\\Users\\Ada Lovelace\\repo"" && set ""CODEX_HOME=C:\\Users\\Ada\\AppData\\Roaming\\Orca\\codex-runtime-home\\home"" && codex resume ""session-1"""'
    )
  })

  it('resumes OMP by absolute transcript path so it resolves across session-dir roots', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'omp',
        sessionId: '019f27cd-4268-7000-96e7-62f42a55c144',
        resumeFilePath:
          '/Users/ada/.omp/agent/sessions/repo/2026-07-03T11-30-29-357Z_019f27be/OmpScannerTests.jsonl',
        cwd: '/Users/ada/repo',
        platform: 'darwin'
      })
    ).toBe(
      "cd '/Users/ada/repo' && omp --resume '/Users/ada/.omp/agent/sessions/repo/2026-07-03T11-30-29-357Z_019f27be/OmpScannerTests.jsonl'"
    )
  })

  it('quotes queued OMP resume paths for the provided Windows shell', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'omp',
        sessionId: '019f27cd-4268-7000-96e7-62f42a55c144',
        resumeFilePath: 'C:\\Users\\Ada Lovelace\\.omp\\agent\\sessions\\repo\\sess.jsonl',
        cwd: 'C:\\Users\\Ada Lovelace\\repo',
        platform: 'win32',
        shell: 'powershell'
      })
    ).toBe(
      "Set-Location -LiteralPath 'C:\\Users\\Ada Lovelace\\repo'; omp --resume 'C:\\Users\\Ada Lovelace\\.omp\\agent\\sessions\\repo\\sess.jsonl'"
    )
  })

  it('falls back to the session id when no OMP transcript path is known', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'omp',
        sessionId: '019f27cd-4268-7000-96e7-62f42a55c144',
        resumeFilePath: null,
        cwd: '/Users/ada/repo',
        platform: 'darwin'
      })
    ).toBe("cd '/Users/ada/repo' && omp --resume '019f27cd-4268-7000-96e7-62f42a55c144'")
  })

  it('resumes Prime Agent by absolute transcript path like OMP', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'prime-agent',
        sessionId: 'dddddddd-eeee-4fff-8aaa-111111111111',
        resumeFilePath:
          '/Users/ada/.prime/agent/sessions/dddddddd-eeee-4fff-8aaa-111111111111.jsonl',
        cwd: '/Users/ada/repo',
        platform: 'darwin'
      })
    ).toBe(
      "cd '/Users/ada/repo' && prime-agent --resume '/Users/ada/.prime/agent/sessions/dddddddd-eeee-4fff-8aaa-111111111111.jsonl'"
    )
  })

  it('falls back to the session id when no Prime Agent transcript path is known', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'prime-agent',
        sessionId: 'dddddddd-eeee-4fff-8aaa-111111111111',
        resumeFilePath: null,
        cwd: '/Users/ada/repo',
        platform: 'darwin'
      })
    ).toBe("cd '/Users/ada/repo' && prime-agent --resume 'dddddddd-eeee-4fff-8aaa-111111111111'")
  })
})

describe('buildAiVaultResumeShellCommand env removal', () => {
  const base = {
    resumeCommand: "codex 'resume' 'sid'",
    cwd: '/repo',
    clearEnvNames: ['CODEX_HOME', 'ORCA_CODEX_HOME']
  }

  it('carries the removal on the agent under a POSIX shell', () => {
    expect(buildAiVaultResumeShellCommand({ ...base, platform: 'darwin' })).toBe(
      "cd '/repo' && env -u CODEX_HOME -u ORCA_CODEX_HOME codex 'resume' 'sid'"
    )
  })

  // Why: `env -u` strips what the assignment just set, so an unfiltered list
  // would silently resume against the real home instead of the pinned one.
  it('keeps a pinned CODEX_HOME authoritative instead of stripping it', () => {
    const command = buildAiVaultResumeShellCommand({
      ...base,
      platform: 'darwin',
      codexHome: '/home/a/.codex-work'
    })

    expect(command).toBe(
      "cd '/repo' && CODEX_HOME='/home/a/.codex-work' env -u ORCA_CODEX_HOME codex 'resume' 'sid'"
    )
    expect(command).not.toContain('-u CODEX_HOME')
  })

  it('keeps a pinned CODEX_HOME authoritative under a git-bash shell too', () => {
    expect(
      buildAiVaultResumeShellCommand({
        ...base,
        platform: 'win32',
        shell: 'posix',
        codexHome: '/c/users/a/.codex-work'
      })
    ).toBe(
      "cd '/repo' && CODEX_HOME='/c/users/a/.codex-work' env -u ORCA_CODEX_HOME codex 'resume' 'sid'"
    )
  })

  // Why: the shell decides the grammar, not the host. Keying placement on the
  // platform emitted POSIX `env -u` into a PowerShell line.
  it('uses PowerShell grammar for a PowerShell shell on a non-Windows host', () => {
    const command = buildAiVaultResumeShellCommand({
      ...base,
      platform: 'linux',
      shell: 'powershell'
    })

    expect(command).not.toContain('env -u')
    expect(command).toBe(
      'Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue; ' +
        'Remove-Item Env:ORCA_CODEX_HOME -ErrorAction SilentlyContinue; ' +
        "Set-Location -LiteralPath '/repo'; codex 'resume' 'sid'"
    )
  })

  it('keeps the cmd clear ahead of the cd so a failed cd cannot launch the agent', () => {
    expect(
      buildAiVaultResumeShellCommand({
        ...base,
        cwd: 'C:\\repo',
        platform: 'win32',
        shell: 'cmd'
      })
    ).toBe(
      'set "CODEX_HOME=" & set "ORCA_CODEX_HOME=" & cd /d "C:\\repo" && codex \'resume\' \'sid\''
    )
  })
})
