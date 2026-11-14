import { describe, expect, it } from 'vitest'
import { resolveRemoteOperationErrorMessage } from './source-control-remote-error'

describe('source-control remote error formatting', () => {
  it.each([
    [{ isFetch: true }, 'Fetch failed. '],
    [{ isFastForward: true }, 'Fast-forward failed. '],
    [{ isRebase: true }, 'Rebase failed. '],
    [{}, '']
  ])('redacts ANSI-bearing credentials in fallback details for %j', (options, prefix) => {
    const error = new Error('Access denied to https://user:sec\x1b[1 qret@example.com/repo.git')

    expect(resolveRemoteOperationErrorMessage(error, options)).toBe(
      `${prefix}Access denied to https://example.com/repo.git`
    )
    expect(error.message).toContain('user:sec\x1b[1 qret@')
  })
})
