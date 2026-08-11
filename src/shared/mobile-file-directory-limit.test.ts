import { describe, expect, it } from 'vitest'
import {
  assertMobileFileDirectoryWithinLimit,
  MOBILE_FILE_DIRECTORY_LIMIT_MESSAGE,
  MOBILE_FILE_DIRECTORY_MAX_ENTRIES,
  MOBILE_FILE_DIRECTORY_MAX_RETAINED_BYTES
} from './mobile-file-directory-limit'

describe('mobile file directory limit', () => {
  it('accepts a complete directory listing within both limits', () => {
    expect(() =>
      assertMobileFileDirectoryWithinLimit([
        { name: 'src' },
        { name: 'README.md' },
        { name: 'package.json' }
      ])
    ).not.toThrow()
  })

  it('rejects rather than truncating an excessive entry count', () => {
    const entries = Array.from({ length: MOBILE_FILE_DIRECTORY_MAX_ENTRIES + 1 }, () => ({
      name: 'x'
    }))

    expect(() => assertMobileFileDirectoryWithinLimit(entries)).toThrow(
      MOBILE_FILE_DIRECTORY_LIMIT_MESSAGE
    )
  })

  it('rejects a listing whose names exceed the retained-byte limit', () => {
    const name = 'x'.repeat(MOBILE_FILE_DIRECTORY_MAX_RETAINED_BYTES / 2)

    expect(() => assertMobileFileDirectoryWithinLimit([{ name }])).toThrow(
      MOBILE_FILE_DIRECTORY_LIMIT_MESSAGE
    )
  })
})
