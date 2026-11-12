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

  it('seeds an initial URL without replacing a committed navigation', () => {
    seedLiveBrowserUrl('page-1', 'https://initial.example/')
    rememberLiveBrowserUrl('page-1', 'https://committed.example/')
    seedLiveBrowserUrl('page-1', 'https://stale-persisted.example/')

    expect(getLiveBrowserUrl('page-1')).toBe('https://committed.example/')
  })
})
