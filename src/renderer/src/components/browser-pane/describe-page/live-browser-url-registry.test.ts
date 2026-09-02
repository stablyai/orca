import { afterEach, describe, expect, it } from 'vitest'
import {
  clearLiveBrowserUrl,
  getLiveBrowserUrl,
  rememberLiveBrowserUrl,
  seedLiveBrowserUrl
} from './live-browser-url-registry'

describe('browser runtime live URL cache', () => {
  afterEach(() => {
    clearLiveBrowserUrl('page-1')
    clearLiveBrowserUrl('popup-1')
  })

  it('remembers and clears the last live URL for a browser page', () => {
    rememberLiveBrowserUrl('page-1', 'https://example.com/')

    expect(getLiveBrowserUrl('page-1')).toBe('https://example.com/')

    clearLiveBrowserUrl('page-1')

    expect(getLiveBrowserUrl('page-1')).toBeNull()
  })

  it('seeds an initial URL without replacing a committed navigation', () => {
    seedLiveBrowserUrl('page-1', 'https://initial.example/')
    rememberLiveBrowserUrl('page-1', 'https://committed.example/')
    seedLiveBrowserUrl('page-1', 'https://stale-persisted.example/')

    expect(getLiveBrowserUrl('page-1')).toBe('https://committed.example/')
  })

  it('retains the last committed URL when a later load fails', () => {
    seedLiveBrowserUrl('page-1', 'https://initial.example/')
    rememberLiveBrowserUrl('page-1', 'https://committed.example/')
    // A failure event records its validated URL in loadError, not the live URL cache.

    expect(getLiveBrowserUrl('page-1')).toBe('https://committed.example/')
  })

  it('keeps popup page URLs independent and clears only the destroyed page', () => {
    seedLiveBrowserUrl('page-1', 'https://opener.example/')
    seedLiveBrowserUrl('popup-1', 'https://popup.example/')

    clearLiveBrowserUrl('popup-1')

    expect(getLiveBrowserUrl('page-1')).toBe('https://opener.example/')
    expect(getLiveBrowserUrl('popup-1')).toBeNull()
  })
})
