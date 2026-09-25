import { describe, expect, it } from 'vitest'
import { isNoWriteFetchHeadUnsupportedError } from './git-fetch-head-capability'

describe('isNoWriteFetchHeadUnsupportedError', () => {
  it.each([
    new Error("error: unknown option `no-write-fetch-head'"),
    { stderr: "error: unrecognized option '--no-write-fetch-head'" },
    { stdout: "fatal: invalid option: 'no-write-fetch-head'" }
  ])('recognizes old-Git option rejection shapes', (error) => {
    expect(isNoWriteFetchHeadUnsupportedError(error)).toBe(true)
  })

  it('does not classify an ordinary fetch failure as unsupported', () => {
    expect(
      isNoWriteFetchHeadUnsupportedError({ stderr: 'fatal: could not read from remote repository' })
    ).toBe(false)
  })
})
