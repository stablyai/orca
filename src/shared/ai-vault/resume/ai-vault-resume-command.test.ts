import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { getAgentResumeArgv } from '../../agent-launch/startup/agent-resume-argv'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand
} from './ai-vault-resume-command'

it.each([
  ['posix', 'linux', "CLAUDE_CONFIG_DIR='/accounts/work home' claude --resume sid"]
] as const)('pins the Claude resume home in %s commands', (shell, platform, expected) => {
  expect(
    buildAiVaultResumeShellCommand({
      resumeCommand: 'claude --resume sid',
      cwd: null,
      shell,
      platform,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/work home' }
    })
  ).toBe(expected)
})

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

describe('Hermes profile session resume', () => {
  it.each([
    ['/home/u/.hermes/state.db#local-1', 'default'],
    ['/home/u/.hermes/profiles/work/state.db#local-1', 'work'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\u\\.hermes\\profiles\\ops\\state.db#local-1', 'ops']
  ])('resumes %s under profile %s, from the row and from a restored pane', (row, profile) => {
    const command = buildAiVaultResumeCommand({
      agent: 'hermes',
      sessionId: 'local-1',
      resumeFilePath: row,
      cwd: null,
      platform: 'linux'
    })
    expect(command).toBe(`hermes -p ${profile} --resume 'local-1'`)
    expect(
      getAgentResumeArgv('hermes', { key: 'session_id', id: 'local-1', transcriptPath: row })
    ).toEqual(['hermes', '-p', profile, '--resume', 'local-1'])
  })
})

it.skipIf(process.platform !== 'win32').each([false, true])(
  'restores PowerShell environment after a resume, including failure=%s',
  (fails) => {
    const command = buildAiVaultResumeShellCommand({
      resumeCommand: `Write-Output ('CHILD=' + $env:CLAUDE_CONFIG_DIR + ';POINTER=' + [bool]$env:ORCA_CLAUDE_PROFILE_POINTER)${fails ? "; throw 'agent failed'" : ''}`,
      cwd: null,
      shell: 'powershell',
      platform: 'win32',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/account/work home' },
      clearEnvNames: ['CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_PROFILE_POINTER']
    })
    const child = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `try { ${command} } catch {}; Write-Output ('PARENT=' + $env:CLAUDE_CONFIG_DIR + ';POINTER=' + $env:ORCA_CLAUDE_PROFILE_POINTER)`
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: '/parent/home',
          ORCA_CLAUDE_PROFILE_POINTER: '/parent/pointer'
        }
      }
    )
    expect(child.status).toBe(0)
    expect(child.stdout.trim().split(/\r?\n/)).toEqual([
      'CHILD=/account/work home;POINTER=False',
      'PARENT=/parent/home;POINTER=/parent/pointer'
    ])
  }
)

it.skipIf(process.platform !== 'win32')(
  'keeps cmd account assignments inside the child command',
  () => {
    const command = buildAiVaultResumeShellCommand({
      resumeCommand: 'set CLAUDE_CONFIG_DIR',
      cwd: null,
      shell: 'cmd',
      platform: 'win32',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: 'C:\\account home' }
    })
    const child = spawnSync('cmd.exe', ['/d', '/q', '/v:on'], {
      input: `@echo off\r\n${command}\r\necho PARENT=!CLAUDE_CONFIG_DIR!\r\nexit\r\n`,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, CLAUDE_CONFIG_DIR: 'C:\\parent home' }
    })
    expect(child.status).toBe(0)
    expect(child.stderr).toBe('')
    expect(child.stdout).toContain('CLAUDE_CONFIG_DIR=C:\\account home')
    expect(child.stdout).toContain('PARENT=C:\\parent home')
  }
)
