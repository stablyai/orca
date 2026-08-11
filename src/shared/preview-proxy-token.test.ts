import { describe, expect, it } from 'vitest'
import { resolvePreviewToken } from './preview-proxy-token'

describe('resolvePreviewToken', () => {
  it('prefers the command-line token over the environment', () => {
    expect(resolvePreviewToken('from-flag', 'from-env')).toBe('from-flag')
  })

  it('trims the environment fallback and ignores an empty value', () => {
    expect(resolvePreviewToken(null, ' from-env ')).toBe('from-env')
    expect(resolvePreviewToken(null, '   ')).toBeNull()
  })
})
