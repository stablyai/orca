import { describe, expect, it } from 'vitest'
import { codeBlockRunOutput } from './code-block-terminal-run'

describe('codeBlockRunOutput', () => {
  it('keeps the lines before the done mark, drops its echo, and reads the exit status', () => {
    const lines = [
      'user@host ~ $ date',
      'printf \'\\n__orca_code_block_done_%s__\\n\' "$?"',
      'Tue Nov 24 18:00:00 UTC 2026',
      '',
      '__orca_code_block_done_0__',
      'user@host ~ $'
    ]
    expect(codeBlockRunOutput(lines)).toEqual({
      output: 'user@host ~ $ date\nTue Nov 24 18:00:00 UTC 2026',
      exitCode: 0
    })
  })

  it('has no exit status while the script still runs', () => {
    expect(codeBlockRunOutput(['$ sleep 5'])).toEqual({ output: '$ sleep 5', exitCode: null })
    expect(codeBlockRunOutput(['$ false', '__orca_code_block_done_1__']).exitCode).toBe(1)
  })
})
