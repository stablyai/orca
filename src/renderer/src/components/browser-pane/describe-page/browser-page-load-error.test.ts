import { describe, expect, it } from 'vitest'
import { buildLoadError } from './browser-page-load-error'

describe('buildLoadError', () => {
  it('fills defaults and redacts the validated URL', () => {
    expect(buildLoadError({})).toEqual({
      code: -1,
      description: 'Unknown load failure',
      validatedUrl: 'about:blank'
    })
    expect(
      buildLoadError({
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED',
        validatedURL: 'https://example.com/app'
      })
    ).toEqual({
      code: -102,
      description: 'ERR_CONNECTION_REFUSED',
      validatedUrl: 'https://example.com/app'
    })
  })
})
