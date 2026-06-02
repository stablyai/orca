import { beforeEach, describe, expect, it } from 'vitest'
import { clearLiveBrowserUrl, getLiveBrowserUrl, rememberLiveBrowserUrl } from './browser-runtime'

describe('browser runtime live URL cache', () => {
  beforeEach(() => {
    clearLiveBrowserUrl('page-1')
  })

  it('remembers and clears the last live URL for a browser page', () => {
    rememberLiveBrowserUrl('page-1', 'https://example.com/')

    expect(getLiveBrowserUrl('page-1')).toBe('https://example.com/')

    clearLiveBrowserUrl('page-1')

    expect(getLiveBrowserUrl('page-1')).toBeNull()
  })
})
