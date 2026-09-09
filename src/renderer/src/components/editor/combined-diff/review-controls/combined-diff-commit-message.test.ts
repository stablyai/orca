import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCombinedDiffCommitMessageBody } from './combined-diff-commit-message'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getCombinedDiffCommitMessageBody', () => {
  it('removes the commit subject from the returned body', () => {
    expect(getCombinedDiffCommitMessageBody('Fix tests\n\nBody line', 'Fix tests')).toBe(
      'Body line'
    )
  })

  it('normalizes CRLF before matching the subject and body', () => {
    expect(getCombinedDiffCommitMessageBody('Fix tests\r\n\r\nBody line', 'Fix tests')).toBe(
      'Body line'
    )
  })

  it('normalizes newline-heavy CRLF bodies without global replace or split', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const split = vi.spyOn(String.prototype, 'split')
    const message = `Fix tests\r\n\r\n${'Body line\r\n'.repeat(10_000)}`

    const result = getCombinedDiffCommitMessageBody(message, 'Fix tests')

    expect(result.startsWith('Body line\nBody line')).toBe(true)
    expect(result).not.toContain('\r\n')
    const usedCrlfReplace = replace.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n'
    )
    expect(usedCrlfReplace).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })

  it('keeps messages without a matching subject and avoids splitting large bodies', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const message = `Subject\n${'body\n'.repeat(10_000)}`

    expect(getCombinedDiffCommitMessageBody(message, 'Other subject')).toBe(message.trim())
    expect(split).not.toHaveBeenCalled()
  })
})
