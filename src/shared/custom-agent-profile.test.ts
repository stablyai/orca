import { describe, expect, it } from 'vitest'
import {
  buildCustomAgentLaunch,
  normalizeCustomAgentProfile,
  normalizeCustomAgentProfiles
} from './custom-agent-profile'

describe('custom agent profiles', () => {
  it('normalizes profiles without changing literal arguments', () => {
    expect(
      normalizeCustomAgentProfiles([
        {
          id: ' luna ',
          name: ' Codex Luna ',
          baseAgent: 'codex',
          baseAgentExecutable: ' codex ',
          executable: ' codex ',
          args: ['--model', 'luna', '']
        },
        {
          id: 'dhimanex',
          name: 'Dhimanex',
          executable: 'dhimanex',
          args: []
        }
      ])
    ).toEqual([
      {
        id: 'luna',
        name: 'Codex Luna',
        baseAgent: 'codex',
        baseAgentExecutable: 'codex',
        executable: 'codex',
        args: ['--model', 'luna', '']
      },
      {
        id: 'dhimanex',
        name: 'Dhimanex',
        executable: 'dhimanex',
        args: []
      }
    ])
  })

  it('keeps only known built-in identity bound to the duplicated executable', () => {
    expect(
      normalizeCustomAgentProfile({
        id: 'luna',
        name: 'Codex Luna',
        baseAgent: 'codex',
        baseAgentExecutable: 'codex',
        executable: 'codex',
        args: ['--model', 'luna']
      })
    ).toEqual({
      id: 'luna',
      name: 'Codex Luna',
      baseAgent: 'codex',
      baseAgentExecutable: 'codex',
      executable: 'codex',
      args: ['--model', 'luna']
    })
    expect(
      normalizeCustomAgentProfile({
        id: 'custom',
        name: 'Custom',
        baseAgent: 'not-real',
        baseAgentExecutable: 'custom',
        executable: 'custom',
        args: []
      })
    ).toEqual({ id: 'custom', name: 'Custom', executable: 'custom', args: [] })
    expect(
      normalizeCustomAgentProfile({
        id: 'repointed',
        name: 'Repointed',
        baseAgent: 'codex',
        baseAgentExecutable: 'codex',
        executable: 'claude',
        args: []
      })
    ).toEqual({ id: 'repointed', name: 'Repointed', executable: 'claude', args: [] })
  })

  it('drops malformed, duplicate, and control-character-bearing profiles', () => {
    const valid = {
      id: 'safe',
      name: 'Safe',
      executable: 'safe',
      args: ['--flag']
    } as const
    expect(
      normalizeCustomAgentProfiles([
        valid,
        { ...valid, id: 'other', name: ' safe ' },
        { ...valid, id: 'safe', name: 'Other' },
        { ...valid, id: 'line-feed', args: ['ok\nrun'] },
        { ...valid, id: 'escape', executable: 'safe\u001b[2J' },
        { ...valid, id: 'missing-executable', executable: '' }
      ])
    ).toEqual([valid])
  })

  it('reserves built-in IDs and display names', () => {
    expect(
      normalizeCustomAgentProfiles([
        { id: 'one', name: 'Codex', executable: 'one', args: [] },
        {
          id: 'two',
          name: 'github copilot',
          executable: 'two',
          args: []
        },
        { id: 'three', name: 'codex', executable: 'three', args: [] }
      ])
    ).toEqual([])
  })

  it('rejects an oversized argument payload', () => {
    expect(
      normalizeCustomAgentProfile({
        id: 'large',
        name: 'Large',
        executable: 'large',
        args: ['x'.repeat(16 * 1024)]
      })
    ).toBeNull()
  })

  it('rejects a combined argv payload that exceeds the Windows environment limit', () => {
    expect(
      normalizeCustomAgentProfile({
        id: 'large-windows-payload',
        name: 'Large Windows payload',
        executable: '😀'.repeat(2048),
        args: ['x'.repeat(16_380)]
      })
    ).toBeNull()
  })

  it('transports Windows argv and quotes POSIX argv as literal data', () => {
    const profile = {
      id: 'luna',
      name: 'Codex Luna',
      executable: 'C:\\Program Files\\Codex\\codex.exe',
      args: ['--model', 'luna pro', '$HOME', '']
    } as const
    const powershellLaunch = buildCustomAgentLaunch(profile, 'powershell')
    expect(powershellLaunch?.command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+; \$orcaAgentExit = \$LASTEXITCODE; Remove-Item Env:ORCA_CUSTOM_AGENT_WINDOWS_ARGV_V1 -ErrorAction SilentlyContinue; & cmd\.exe \/d \/c exit \$orcaAgentExit$/
    )
    expect(powershellLaunch?.command).not.toContain(profile.executable)
    expect(powershellLaunch?.env).toBeDefined()
    expect(buildCustomAgentLaunch(profile, 'posix')).toEqual({
      command: `'C:'"\\\\"'Program Files'"\\\\"'Codex'"\\\\"'codex.exe' '--model' 'luna pro' '$HOME' ''`
    })
    const cmdLaunch = buildCustomAgentLaunch(profile, 'cmd')
    expect(cmdLaunch?.command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+ & set "ORCA_CUSTOM_AGENT_WINDOWS_ARGV_V1="$/
    )
    expect(cmdLaunch?.command).not.toContain(profile.executable)
    expect(cmdLaunch?.env).toEqual(powershellLaunch?.env)
  })
})
