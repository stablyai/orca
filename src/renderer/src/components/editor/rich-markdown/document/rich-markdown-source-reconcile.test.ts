import { describe, expect, it } from 'vitest'
import { reconcileSerializedMarkdown } from './rich-markdown-source-reconcile'

describe('reconcileSerializedMarkdown', () => {
  it('falls back to canonical when the safety re-parse mismatches (branch 6)', () => {
    const reconciled = reconcileSerializedMarkdown({
      originalSource: '_a_\n',
      baseCanonical: '*a*\n',
      edited: '*a* b\n',
      roundTrip: () => 'something entirely different'
    })

    expect(reconciled).toBe('*a* b\n')
  })

  it('restores CRLF on the oversize fallback so a uniform-CRLF file never flips to LF (branch 3)', () => {
    const big = 'line of text\r\n'.repeat(9000)
    const originalSource = `${big}_x_\r\n`
    const editedLf = `${big.replace(/\r\n/g, '\n')}*x* y\n`

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical: `${big.replace(/\r\n/g, '\n')}*x*\n`,
      edited: editedLf,
      roundTrip: () => null
    })

    expect(reconciled).toContain('\r\n')
    expect(reconciled.replace(/\r\n/g, '')).not.toContain('\n')
  })
})
