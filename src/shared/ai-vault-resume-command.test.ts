import { describe, expect, it } from 'vitest'

import { buildAiVaultResumeCommand } from './ai-vault-types'

describe('buildAiVaultResumeCommand', () => {
  it('wraps Windows cwd changes in cmd so PowerShell and cmd launch the same resume command', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'codex',
        sessionId: 'session-1',
        cwd: 'C:\\Users\\Ada Lovelace\\repo',
        platform: 'win32'
      })
    ).toBe('cmd /d /s /c "cd /d ""C:\\Users\\Ada Lovelace\\repo"" && codex resume ""session-1"""')
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
})
