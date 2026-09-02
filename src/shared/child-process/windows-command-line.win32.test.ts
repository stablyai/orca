import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from '../windows-transient-lock-removal'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from './run-process'
import {
  WINDOWS_ARGUMENT_CORPUS,
  WINDOWS_ARGUMENT_CORPUS_ENV
} from './__fixtures__/windows-argument-corpus'

/**
 * The other half of the encoding proof: the unit test checks the bytes against
 * a model of `CommandLineToArgvW`, and this one checks that a real `.cmd` shim
 * on a real Windows box receives exactly what was sent.
 *
 * Both are needed. Two parsers read the line and they disagree, so an encoding
 * can satisfy the model and still be shredded by cmd — which is what shipped.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('Windows .cmd argument round-trip', () => {
  let dir: string
  let shim: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-cmd-argv-'))
    shim = join(dir, 'echoargs.cmd')
    // A shim shaped like the npm/agent CLI wrappers that actually break:
    // `@echo off` plus `%*` forwarding into a real program.
    writeFileSync(shim, '@echo off\r\nnode "%~dp0echoargs.js" %*\r\n')
    writeFileSync(
      join(dir, 'echoargs.js'),
      'process.stdout.write(process.argv.slice(2).map((a) => `ARG<${a}>`).join("\\n"))\n'
    )
  })

  afterAll(() => {
    removeTreeSync(dir)
  })

  function decode(stdout: string): string[] {
    return [...stdout.matchAll(/ARG<([\s\S]*?)>(?=\nARG<|$)/g)].map((match) => match[1]!)
  }

  it.each(WINDOWS_ARGUMENT_CORPUS)('delivers $name unchanged', async ({ value }) => {
    const result = await runProcess({
      program: shim,
      args: [value],
      // Why a populated env: `%F%` and `%VAR%` must be live variables here, or
      // the percent cases pass by accident against an undefined name.
      env: { ...process.env, ...WINDOWS_ARGUMENT_CORPUS_ENV },
      timeoutMs: 30_000
    })
    expect(result.code).toBe(0)
    expect(decode(result.stdout)).toEqual([value])
  })

  it('delivers the whole corpus in one invocation', async () => {
    // The composed case is the one that regressed: a single argument can look
    // fine while leaving cmd mid-quote, and only the NEXT argument's `&` shows
    // it — as a truncation plus command execution.
    const values = WINDOWS_ARGUMENT_CORPUS.map((entry) => entry.value)
    const result = await runProcess({
      program: shim,
      args: values,
      env: { ...process.env, ...WINDOWS_ARGUMENT_CORPUS_ENV },
      timeoutMs: 30_000
    })
    expect(result.code).toBe(0)
    expect(decode(result.stdout)).toEqual(values)
  })

  it('does not execute the tail of an argument containing an ampersand', async () => {
    // Before the fix this argument arrived as "a" and `echo PWNED` ran.
    const marker = join(dir, 'pwned.txt')
    const result = await runProcess({
      program: shim,
      args: [`a& echo PWNED> "${marker}" &b`],
      timeoutMs: 30_000
    })
    expect(decode(result.stdout)).toEqual([`a& echo PWNED> "${marker}" &b`])
    expect(() => rmSync(marker)).toThrow()
  })
})
