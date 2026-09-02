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
  const corpusValues = WINDOWS_ARGUMENT_CORPUS.map((entry) => entry.value)
  const argvMarker = 'ORCA_CUSTOM_AGENT_ARGV:'

  function readMarkedJson(stdout: string, marker = argvMarker): unknown {
    const payload = stdout.slice(stdout.indexOf(marker) + marker.length).split(/\r?\n/, 1)[0]!
    return JSON.parse(payload)
  }

  function runCmdLaunch(
    launch: ReturnType<typeof buildCustomAgentLaunch>,
    env: NodeJS.ProcessEnv = {},
    delayedExpansion = false
  ) {
    return runProcess({
      program: getCmdExePath(),
      args: ['/d', '/q', delayedExpansion ? '/v:on' : '/v:off'],
      input: `${launch.command}\r\nexit /b %errorlevel%\r\n`,
      env: { ...process.env, ...env, ...launch.env },
      timeoutMs: 30_000
    })
  }

  function runPowerShellLaunch(
    launch: ReturnType<typeof buildCustomAgentLaunch>,
    suffix: string,
    env: NodeJS.ProcessEnv = {}
  ) {
    return runProcess({
      program: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${launch.command}${suffix}`
      ],
      env: { ...process.env, ...env, ...launch.env },
      timeoutMs: 30_000
    })
  }

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
    const launch = buildCustomAgentLaunch(
      {
        id: 'literal-argv',
        name: 'Literal argv',
        executable: process.execPath,
        args: [
          '-e',
          `process.stdout.write(${JSON.stringify(argvMarker)} + JSON.stringify(process.argv.slice(1)))`,
          '--',
          ...corpusValues
        ]
      },
      'cmd'
    )

    const result = await runCmdLaunch(launch, WINDOWS_ARGUMENT_CORPUS_ENV, true)

    expect(result.code, JSON.stringify(result)).toBe(0)
    expect(readMarkedJson(result.stdout)).toEqual(corpusValues)
  })

  it('delivers the adversarial corpus unchanged through the default PowerShell', async () => {
    const launch = buildCustomAgentLaunch(
      {
        id: 'literal-argv-powershell',
        name: 'Literal argv PowerShell',
        executable: process.execPath,
        args: [
          '-e',
          `process.stdout.write(${JSON.stringify(argvMarker)} + JSON.stringify(process.argv.slice(1)))`,
          '--',
          ...corpusValues
        ]
      },
      'powershell'
    )
    const argvEnv = Object.keys(launch.env ?? {})[0]
    expect(argvEnv).toBeTruthy()

    const result = await runPowerShellLaunch(
      launch,
      `; if (Test-Path Env:${argvEnv}) { exit 86 }`,
      WINDOWS_ARGUMENT_CORPUS_ENV
    )

    expect(result.code, JSON.stringify(result)).toBe(0)
    expect(readMarkedJson(result.stdout)).toEqual(corpusValues)
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

    const result = await runPowerShellLaunch(
      launch,
      '; Write-Output "ORCA_EXIT:$($LASTEXITCODE)"; exit $LASTEXITCODE'
    )

    expect(result.code, JSON.stringify(result)).toBe(37)
    expect(result.stdout).toContain('ORCA_EXIT:37')
  })

  it('delivers the corpus through a bare cmd shim unchanged', async () => {
    const launch = buildCustomAgentLaunch(
      {
        id: 'cmd-shim',
        name: 'Cmd shim',
        executable: 'echoargs',
        args: corpusValues
      },
      'cmd'
    )

    const result = await runCmdLaunch(
      launch,
      {
        ...WINDOWS_ARGUMENT_CORPUS_ENV,
        PATH: `${shimDir};${process.env.PATH ?? ''}`,
        TEMP: runnerTempDir,
        TMP: runnerTempDir
      },
      true
    )

    expect(result.code, JSON.stringify(result)).toBe(0)
    expect(readMarkedJson(result.stdout)).toEqual(corpusValues)
    expect(readdirSync(runnerTempDir)).toEqual([])
  })

  it('launches a profile with no arguments', async () => {
    const launch = buildCustomAgentLaunch(
      {
        id: 'no-arguments',
        name: 'No arguments',
        executable: 'echoargs',
        args: []
      },
      'cmd'
    )

    const result = await runCmdLaunch(launch, {
      PATH: `${shimDir};${process.env.PATH ?? ''}`
    })

    expect(result.code, JSON.stringify(result)).toBe(0)
    expect(result.stdout).toContain(`${argvMarker}[]`)
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

    const result = await runCmdLaunch(launch)

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
