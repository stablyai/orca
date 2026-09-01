import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkoutRunProcessPath, formatProbeFailure, packagedProbeInvocation } from './run.mjs'

const runnerSource = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8')

describe('packaged Windows native smoke runner boundary', () => {
  it('uses one checkout-owned runner for current and affected package paths', () => {
    const current = packagedProbeInvocation('/ci/current/dist/win-unpacked/Orca.exe')
    const affected = packagedProbeInvocation('/ci/1.4.158/dist/win-unpacked/Orca.exe')

    expect(checkoutRunProcessPath()).toBe(path.resolve('out/shared/child-process/run-process.js'))
    expect(current.program).not.toBe(affected.program)
    expect(current.args[0]).toBe(affected.args[0])
    expect(current.args[1]).toBe('--exercise')
    expect(current.args[2]).not.toBe(affected.args[2])
    expect(current.args[3]).toBe(process.execPath)
    expect(affected.args[3]).toBe(process.execPath)
    expect(current.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(affected.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(current.timeoutMs).toBe(affected.timeoutMs)
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
