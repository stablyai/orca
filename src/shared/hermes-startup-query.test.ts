import { describe, expect, it } from 'vitest'
import { ORCA_HERMES_STARTUP_QUERY_ENV, planHermesStartupQuery } from './hermes-startup-query'

const QUERY_PLACEHOLDER = '__ORCA_HERMES_STARTUP_QUERY__'

function planPosix(baseCommand: string, prompt: string, agentEnv?: Record<string, string>) {
  return planHermesStartupQuery({
    baseCommand,
    prompt,
    agentEnv,
    platform: 'linux',
    shell: 'posix'
  })
}

describe('planHermesStartupQuery wrapper recognition', () => {
  it('plans a native query for the plain hermes binary', () => {
    const plan = planPosix('hermes', 'do the thing')
    expect(plan).not.toBeNull()
    expect(plan!.env[ORCA_HERMES_STARTUP_QUERY_ENV]).toBe('do the thing')
    expect(plan!.command.startsWith('sh -c ')).toBe(true)
  })

  it('recognizes interpreter and shim wrappers that keep the hermes stem', () => {
    for (const baseCommand of [
      'python3 /opt/tools/hermes.py',
      'node /opt/tools/hermes.js',
      '/usr/local/bin/hermes.sh',
      'hermes.exe'
    ]) {
      const plan = planPosix(baseCommand, 'do X')
      expect(plan, baseCommand).not.toBeNull()
      expect(plan!.env[ORCA_HERMES_STARTUP_QUERY_ENV]).toBe('do X')
    }
  })

  it('returns null for commands with no hermes executable token', () => {
    expect(planPosix('python3 /opt/tools/runner.py', 'do X')).toBeNull()
    expect(planPosix('claude', 'do X')).toBeNull()
  })
})

describe('planHermesStartupQuery oversized-prompt fallback', () => {
  const oversized = 'x'.repeat(30_000)

  it('launches Hermes bare with a notice instead of returning null', () => {
    const plan = planPosix('hermes', oversized)
    expect(plan).not.toBeNull()
    // Prompt is not carried on the env transport for the fallback launch.
    expect(plan!.env[ORCA_HERMES_STARTUP_QUERY_ENV]).toBeUndefined()
    // Hermes still launches interactively; the query placeholder is dropped.
    expect(plan!.command).toContain('hermes')
    expect(plan!.command).toContain('chat')
    expect(plan!.command).toContain('--tui')
    expect(plan!.command).not.toContain(QUERY_PLACEHOLDER)
    // A visible notice explains the dropped prompt (never a silent failure).
    expect(plan!.command).toContain('was not auto-delivered')
    // No env-based transport or paste path is reintroduced.
    expect(plan!.command).not.toContain(ORCA_HERMES_STARTUP_QUERY_ENV)
  })

  it('preserves unrelated agent env while dropping the query transport', () => {
    const plan = planPosix('hermes', oversized, { FOO: 'bar' })
    expect(plan).not.toBeNull()
    expect(plan!.env).toEqual({ FOO: 'bar' })
  })

  it('emits a powershell bare launch for oversized prompts on windows', () => {
    const plan = planHermesStartupQuery({
      baseCommand: 'hermes.exe',
      prompt: oversized,
      platform: 'win32',
      shell: 'powershell'
    })
    expect(plan).not.toBeNull()
    expect(plan!.env[ORCA_HERMES_STARTUP_QUERY_ENV]).toBeUndefined()
    expect(plan!.command.startsWith('powershell.exe -NoProfile -EncodedCommand ')).toBe(true)
  })
})
