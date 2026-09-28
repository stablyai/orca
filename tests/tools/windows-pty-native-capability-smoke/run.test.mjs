import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkoutRunProcessPath, formatProbeFailure, packagedProbeInvocation } from './run.mjs'

const runnerSource = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8')

describe('packaged Windows native smoke runner boundary', () => {
  it('runs the packaged runtime with its provider and explicit config', () => {
    const current = packagedProbeInvocation(
      '/ci/current/dist/win-unpacked/Orca.exe',
      '/tmp/probe/capability-adapter.cjs',
      { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', BUN_CONPTY_LIBRARY: 'untrusted.dll' }
    )
    expect(checkoutRunProcessPath()).toBe(path.resolve('out/shared/child-process/run-process.js'))
    expect(current.program).toBe(
      '/ci/current/dist/win-unpacked/resources/cli-runtime/bun-runtime.exe'
    )
    expect(current.args.slice(0, 2)).toEqual([
      '--no-env-file',
      `--config=${path.join(path.dirname('/tmp/probe/capability-adapter.cjs'), 'bunfig.toml')}`
    ])
    expect(current.args).toContain('--exercise')
    expect(current.args.at(-1)).toBe('/tmp/probe/capability-adapter.cjs')
    expect(current.args.at(-2)).toBe(process.execPath)
    expect(current.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(current.env.NODE_OPTIONS).toBeUndefined()
    expect(current.env.BUN_CONPTY_LIBRARY).toBe(
      path.join(
        path.resolve('/ci/current/dist/win-unpacked'),
        'resources',
        'cli-runtime',
        'conpty',
        'conpty.dll'
      )
    )
    expect(current.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(current.timeoutMs).toBe(45_000)
  })

  it('keeps timeout evidence bounded and preserves both output channels', () => {
    const failure = formatProbeFailure({
      code: null,
      timedOut: true,
      stdout: `old-${'x'.repeat(9_000)}-stdout-tail`,
      stderr: 'stage=target-spawn:start'
    })

    expect(failure).toContain('code=null, timedOut=true')
    expect(failure).not.toContain('old-')
    expect(failure).toContain('stdout-tail')
    expect(failure).toContain('stage=target-spawn:start')
  })

  it('does not import child_process or resolve the runner from the artifact', () => {
    expect(runnerSource).not.toContain('node:child_process')
    expect(runnerSource).not.toMatch(
      /path\.join\(resourcesDir[\s\S]*?app\.asar\.unpacked[\s\S]*?run-process\.js/
    )
    expect(runnerSource).toContain("'../../../out/shared/child-process/run-process.js'")
  })
})
