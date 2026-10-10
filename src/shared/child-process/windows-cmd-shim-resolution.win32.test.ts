import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../windows-transient-lock-removal'
import { runProcess } from './run-process'
import { WINDOWS_ARGUMENT_CORPUS } from './__fixtures__/windows-argument-corpus'
import { npmProgNodeShim } from './__fixtures__/windows-cmd-shim-bodies'

/**
 * The resolved path has to deliver exactly what the cmd.exe path delivers, for
 * the same real shim on a real Windows box. Anything less and removing cmd.exe
 * has traded an EDR alert for a silent argument bug.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('resolved .cmd shim spawn', () => {
  let dir: string
  let shim: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-shim-spawn-'))
    shim = join(dir, 'echoargs.cmd')
    writeFileSync(shim, npmProgNodeShim('echoargs.js'))
    writeFileSync(
      join(dir, 'echoargs.js'),
      'process.stdout.write(process.argv.slice(2).map((a) => `ARG<${a}>`).join("\\u0000"))\n'
    )
  })

  afterAll(() => {
    removeTreeSync(dir)
  })

  function decode(stdout: string): string[] {
    return stdout.split('\u0000').map((entry) => entry.replace(/^ARG<([\s\S]*)>$/, '$1'))
  }

  it('delivers the whole adversarial corpus through the resolved shim', async () => {
    const values = WINDOWS_ARGUMENT_CORPUS.map((entry) => entry.value)
    const result = await runProcess({
      program: shim,
      args: values,
      timeoutMs: 30_000
    })
    expect(result.code).toBe(0)
    expect(decode(result.stdout)).toEqual(values)
  })

  it('delivers a multi-line agent prompt that cmd.exe could not carry at all', async () => {
    // cmd ends the command at a raw CR/LF whatever the quote state, so the
    // fallback path has to reject this input. Resolving the shim is what makes
    // it expressible.
    const prompt = 'Fix "src/a b.ts"\n- run tests\r\n- report 100% & stop'
    const result = await runProcess({
      program: shim,
      args: [prompt],
      timeoutMs: 30_000
    })
    expect(result.code).toBe(0)
    expect(decode(result.stdout)).toEqual([prompt])
  })

  it('reports the script exit code without a cmd.exe hop in between', async () => {
    const failing = join(dir, 'fail.cmd')
    writeFileSync(failing, npmProgNodeShim('fail.js'))
    writeFileSync(join(dir, 'fail.js'), 'process.exit(7)\n')
    const result = await runProcess({ program: failing, timeoutMs: 30_000 })
    expect(result.code).toBe(7)
  })
})
