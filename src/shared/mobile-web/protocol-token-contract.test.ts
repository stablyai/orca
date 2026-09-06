import { describe, expect, it } from 'vitest'
import {
  isMobileWebBase64,
  isMobileWebBase64UrlIdentifier,
  isMobileWebGitObjectId,
  isMobileWebSha256
} from './protocol-token-contract'

describe('mobile web protocol token contract', () => {
  it.each(['', 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(64)}\n`, 'A'.repeat(64)])(
    'rejects noncanonical SHA-256 token %s',
    (value) => {
      expect(isMobileWebSha256(value)).toBe(false)
    }
  )

  it('accepts an exact lowercase SHA-256 token', () => {
    expect(isMobileWebSha256('a'.repeat(64))).toBe(true)
  })

  it.each(['a'.repeat(39), 'a'.repeat(41), `${'a'.repeat(40)}\n`, 'g'.repeat(40)])(
    'rejects noncanonical Git object ID %s',
    (value) => {
      expect(isMobileWebGitObjectId(value)).toBe(false)
    }
  )

  it.each(['a'.repeat(40), 'A'.repeat(64)])('accepts complete Git object ID %s', (value) => {
    expect(isMobileWebGitObjectId(value)).toBe(true)
  })

  it.each(['', 'a'.repeat(21), 'a'.repeat(23), `${'a'.repeat(22)}\n`, '+'.repeat(22)])(
    'rejects noncanonical fixed base64url token %s',
    (value) => {
      expect(isMobileWebBase64UrlIdentifier(value, 22)).toBe(false)
    }
  )

  it('accepts an exact fixed base64url token', () => {
    expect(isMobileWebBase64UrlIdentifier(`${'a_-A'.repeat(5)}a_`, 22)).toBe(true)
  })

  it('enforces ranged base64url token lengths', () => {
    expect(isMobileWebBase64UrlIdentifier('a'.repeat(16), 16, 64)).toBe(true)
    expect(isMobileWebBase64UrlIdentifier('a'.repeat(64), 16, 64)).toBe(true)
    expect(isMobileWebBase64UrlIdentifier('a'.repeat(15), 16, 64)).toBe(false)
    expect(isMobileWebBase64UrlIdentifier('a'.repeat(65), 16, 64)).toBe(false)
  })

  it.each(['YQ=', 'YQ===', 'YQ==\n', '***=', 'YQ==YQ=='])(
    'rejects noncanonical base64 token %s',
    (value) => {
      expect(isMobileWebBase64(value)).toBe(false)
    }
  )

  it.each(['', 'YQ==', 'YWJj', 'YWJjZA=='])('accepts canonical base64 token %s', (value) => {
    expect(isMobileWebBase64(value)).toBe(true)
  })
})
