import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from '../../windows-transient-lock-removal'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  WINDOWS_ARGUMENT_CORPUS,
  WINDOWS_ARGUMENT_CORPUS_ENV
} from '../../../packages/process-host/src/__fixtures__/windows-argument-corpus'

/** Real Windows cmd-shim round trips complement the CommandLineToArgvW model: the two parsers disagree, so either proof alone can miss corruption. */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('Windows .cmd argument round-trip', () => {
  let dir: string
  let shim: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-cmd-argv-'))
    shim = join(dir, 'echoargs.cmd')
    // Match real npm shims: echo off and %* forwarding into Node.
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
      // Populate variables so percent-expansion cases cannot pass against undefined names.
      env: { ...process.env, ...WINDOWS_ARGUMENT_CORPUS_ENV },
      timeoutMs: 30_000
    })
    expect(result.code).toBe(0)
    expect(decode(result.stdout)).toEqual([value])
  })

  it('delivers the whole corpus in one invocation', async () => {
    // One argument can leave cmd mid-quote; the next argument's ampersand exposes truncation/command execution.
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
