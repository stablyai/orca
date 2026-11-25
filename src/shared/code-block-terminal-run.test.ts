import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { codeBlockRunCommand, codeBlockRunOutput } from './code-block-terminal-run'

const MARK = '__orca_run_test'

describe('codeBlockRunOutput', () => {
  it('keeps only the lines between this run’s marks and reads the exit status', () => {
    const lines = [
      `user@host ~ $ 'sh' '-c' '...' '${MARK}' 'bash'`,
      '',
      `${MARK}_start`,
      'Tue Nov 24 18:00:00 UTC 2026',
      '__orca_run_other_done_0',
      '',
      `${MARK}_done_3  `,
      'user@host ~ $'
    ]
    expect(codeBlockRunOutput(lines, MARK)).toEqual({
      output: 'Tue Nov 24 18:00:00 UTC 2026\n__orca_run_other_done_0',
      exitCode: 3
    })
    expect(codeBlockRunOutput([`${MARK}_start`, 'building'], MARK)).toEqual({
      output: 'building',
      exitCode: null
    })
  })
})

describe.skipIf(process.platform === 'win32')('codeBlockRunCommand', () => {
  it('runs the block as written and reports its exit, even when it calls exit', () => {
    const script = "printf '%s\\n' \"a\\\\b c'd\"\nprintf 'x\\ty\\n' | od -c | head -1\nexit 3"
    const command = codeBlockRunCommand({ script, shell: 'sh' }, MARK)
    expect(command).not.toMatch(/[\t\n]/)
    const lines = execFileSync('sh', ['-c', `${command}; true`], { encoding: 'utf8' }).split('\n')
    const { output, exitCode } = codeBlockRunOutput(lines, MARK)
    expect(exitCode).toBe(3)
    expect(output.split('\n')[0]).toBe("a\\b c'd")
    expect(output).toContain('x  \\t   y')
  })
})
