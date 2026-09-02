import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import {
  WINDOWS_ARGUMENT_CORPUS,
  WINDOWS_ARGUMENT_CORPUS_ENV
} from './child-process/__fixtures__/windows-argument-corpus'
import { buildCustomAgentLaunch, normalizeCustomAgentProfile } from './custom-agent-profile'
import { getCmdExePath } from './windows-batch-spawn'
import { removeTreeSync } from './windows-transient-lock-removal'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('custom agent Windows argument round-trip', () => {
  let shimDir: string
  let runnerTempDir: string

  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), 'orca-custom-agent-argv-'))
    runnerTempDir = join(shimDir, 'runner temp')
    mkdirSync(runnerTempDir)
    writeFileSync(join(shimDir, 'echoargs.cmd'), '@echo off\r\nnode "%~dp0echoargs.js" %*\r\n')
    writeFileSync(
      join(shimDir, 'echoargs.js'),
      'process.stdout.write("ORCA_CUSTOM_AGENT_ARGV:" + JSON.stringify(process.argv.slice(2)))\n'
    )
  })

  afterAll(() => removeTreeSync(shimDir))

  it('delivers the adversarial Windows argument corpus unchanged', async () => {
    const values = WINDOWS_ARGUMENT_CORPUS.map((entry) => entry.value)
    const marker = 'ORCA_CUSTOM_AGENT_ARGV:'
    const launch = buildCustomAgentLaunch(
      {
        id: 'literal-argv',
        name: 'Literal argv',
        executable: process.execPath,
        args: [
          '-e',
          `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(process.argv.slice(1)))`,
          '--',
          ...values
        ]
      },
      'cmd'
    )

    const result = await runProcess({
      program: getCmdExePath(),
      args: ['/d', '/q', '/v:on'],
      input: `${launch.command}\r\nexit /b %errorlevel%\r\n`,
      env: { ...process.env, ...WINDOWS_ARGUMENT_CORPUS_ENV, ...launch.env },
      timeoutMs: 30_000
    })

    expect(result.code, JSON.stringify(result)).toBe(0)
    const payload = result.stdout
      .slice(result.stdout.indexOf(marker) + marker.length)
      .split(/\r?\n/, 1)[0]!
    expect(JSON.parse(payload)).toEqual(values)
  })

  it('delivers the adversarial corpus unchanged through the default PowerShell', async () => {
    const values = WINDOWS_ARGUMENT_CORPUS.map((entry) => entry.value)
    const marker = 'ORCA_CUSTOM_AGENT_ARGV:'
    const launch = buildCustomAgentLaunch(
      {
        id: 'literal-argv-powershell',
        name: 'Literal argv PowerShell',
        executable: process.execPath,
        args: [
          '-e',
          `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(process.argv.slice(1)))`,
          '--',
          ...values
        ]
      },
      'powershell'
    )
    const argvEnv = Object.keys(launch.env ?? {})[0]
    expect(argvEnv).toBeTruthy()

    const result = await runProcess({
      program: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${launch.command}; if (Test-Path Env:${argvEnv}) { exit 86 }`
      ],
      env: { ...process.env, ...WINDOWS_ARGUMENT_CORPUS_ENV, ...launch.env },
      timeoutMs: 30_000
    })

    expect(result.code, JSON.stringify(result)).toBe(0)
    const payload = result.stdout
      .slice(result.stdout.indexOf(marker) + marker.length)
      .split(/\r?\n/, 1)[0]!
    expect(JSON.parse(payload)).toEqual(values)
  })

  it('preserves a failed agent exit status in the parent PowerShell', async () => {
    const launch = buildCustomAgentLaunch(
      {
        id: 'failed-agent-powershell',
        name: 'Failed agent PowerShell',
        executable: process.execPath,
        args: ['-e', 'process.exit(37)']
      },
      'powershell'
    )

    const result = await runProcess({
      program: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${launch.command}; Write-Output "ORCA_EXIT:$($LASTEXITCODE)"; exit $LASTEXITCODE`
      ],
      env: { ...process.env, ...launch.env },
      timeoutMs: 30_000
    })

    expect(result.code, JSON.stringify(result)).toBe(37)
    expect(result.stdout).toContain('ORCA_EXIT:37')
  })

  it('delivers the corpus through a bare cmd shim unchanged', async () => {
    const values = WINDOWS_ARGUMENT_CORPUS.map((entry) => entry.value)
    const marker = 'ORCA_CUSTOM_AGENT_ARGV:'
    const launch = buildCustomAgentLaunch(
      {
        id: 'cmd-shim',
        name: 'Cmd shim',
        executable: 'echoargs',
        args: values
      },
      'cmd'
    )

    const result = await runProcess({
      program: getCmdExePath(),
      args: ['/d', '/q', '/v:on'],
      input: `${launch.command}\r\nexit /b %errorlevel%\r\n`,
      env: {
        ...process.env,
        ...WINDOWS_ARGUMENT_CORPUS_ENV,
        PATH: `${shimDir};${process.env.PATH ?? ''}`,
        TEMP: runnerTempDir,
        TMP: runnerTempDir,
        ...launch.env
      },
      timeoutMs: 30_000
    })

    expect(result.code, JSON.stringify(result)).toBe(0)
    const payload = result.stdout
      .slice(result.stdout.indexOf(marker) + marker.length)
      .split(/\r?\n/, 1)[0]!
    expect(JSON.parse(payload)).toEqual(values)
    expect(readdirSync(runnerTempDir)).toEqual([])
  })

  it('launches a profile with no arguments', async () => {
    const marker = 'ORCA_CUSTOM_AGENT_ARGV:'
    const launch = buildCustomAgentLaunch(
      {
        id: 'no-arguments',
        name: 'No arguments',
        executable: 'echoargs',
        args: []
      },
      'cmd'
    )

    const result = await runProcess({
      program: getCmdExePath(),
      args: ['/d', '/q', '/v:off'],
      input: `${launch.command}\r\nexit /b %errorlevel%\r\n`,
      env: { ...process.env, PATH: `${shimDir};${process.env.PATH ?? ''}`, ...launch.env },
      timeoutMs: 30_000
    })

    expect(result.code, JSON.stringify(result)).toBe(0)
    expect(result.stdout).toContain(`${marker}[]`)
  })

  it('keeps the shell command bounded for a maximum-size valid argument payload', async () => {
    const marker = 'ORCA_CUSTOM_AGENT_LARGE_ARG:'
    const script = `process.stdout.write(${JSON.stringify(marker)} + process.argv[1].length)`
    const fixedPayloadBytes = new TextEncoder().encode(
      JSON.stringify(['-e', script, ''])
    ).byteLength
    const argument = 'x'.repeat(16 * 1024 - fixedPayloadBytes)
    const launch = buildCustomAgentLaunch(
      {
        id: 'large-argv',
        name: 'Large argv',
        executable: process.execPath,
        args: ['-e', script, argument]
      },
      'cmd'
    )
    expect(launch.command.length).toBeLessThan(8192)

    const result = await runProcess({
      program: getCmdExePath(),
      args: ['/d', '/q', '/v:off'],
      input: `${launch.command}\r\nexit /b %errorlevel%\r\n`,
      env: { ...process.env, ...launch.env },
      timeoutMs: 30_000
    })

    expect(result.code, JSON.stringify(result)).toBe(0)
    expect(result.stdout).toContain(`${marker}${argument.length}`)
  })

  it('rejects additional arguments that overflow the Windows environment payload', () => {
    const profile = normalizeCustomAgentProfile({
      id: 'additional-argument-overflow',
      name: 'Additional argument overflow',
      executable: 'codex',
      args: ['x'.repeat(16_000)]
    })!

    expect(() => buildCustomAgentLaunch(profile, 'powershell', ['y'.repeat(9_000)])).toThrow(
      'Custom agent launch arguments exceed the Windows environment limit.'
    )
  })
})
