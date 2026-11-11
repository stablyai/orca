import { describe, expect, it } from 'vitest'

import { getAgentResumeArgv } from '../../agent-launch/startup/agent-resume-argv'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand
} from './ai-vault-resume-command'

describe('buildAiVaultResumeShellCommand env removal', () => {
  const base = {
    resumeCommand: "codex 'resume' 'sid'",
    cwd: '/repo',
    clearEnvNames: ['CODEX_HOME', 'ORCA_CODEX_HOME']
  }

  // Filter assigned variables from env -u or the pinned home silently becomes real-home resume.
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

  // Shell grammar wins over host platform; platform routing emitted POSIX env -u into PowerShell.
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

// STA-14815: OMP takes its profile from flag or env only, so a bare --resume opened a profile's chat under the default profile.
describe('OMP profile session resume', () => {
  it.each([
    ['/home/u/.omp/profiles/qwen/agent/sessions/b/s.jsonl', 'qwen'],
    ['/home/u/.local/share/omp/profiles/work.2/sessions/b/s.jsonl', 'work.2']
  ])('resumes %s under profile %s', (transcript, profile) => {
    const command = buildAiVaultResumeCommand({
      agent: 'omp',
      sessionId: 'sid',
      resumeFilePath: transcript,
      cwd: null,
      platform: 'linux'
    })
    expect(command).toBe(`omp --profile ${profile} --resume '${transcript}'`)
    expect(getAgentResumeArgv('omp', { key: 'session_id', id: 'sid' }, transcript)).toEqual([
      'omp',
      '--profile',
      profile,
      '--resume',
      transcript
    ])
  })
})
