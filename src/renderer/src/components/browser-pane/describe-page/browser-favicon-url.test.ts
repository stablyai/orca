import { describe, expect, it } from 'vitest'
import {
  browserNavigationLeavesFaviconOrigin,
  displayableFaviconUrl,
  pickDisplayableFaviconUrl
} from './browser-favicon-url'

describe('displayableFaviconUrl', () => {
  it('accepts http, https and image data urls', () => {
    expect(displayableFaviconUrl('https://github.com/favicon.ico')).toBe(
      'https://github.com/favicon.ico'
    )
    expect(displayableFaviconUrl('http://127.0.0.1:8765/favicon.ico')).toBe(
      'http://127.0.0.1:8765/favicon.ico'
    )
    expect(displayableFaviconUrl('  data:image/png;base64,AAAA  ')).toBe(
      'data:image/png;base64,AAAA'
    )
  })

  it('rejects the empty-icon sentinel and non-web schemes', () => {
    expect(displayableFaviconUrl('data:,')).toBeNull()
    expect(displayableFaviconUrl('chrome-extension://abc/icon.png')).toBeNull()
    expect(displayableFaviconUrl('file:///tmp/icon.png')).toBeNull()
    expect(displayableFaviconUrl('not a url')).toBeNull()
    expect(displayableFaviconUrl(null)).toBeNull()
    expect(displayableFaviconUrl('   ')).toBeNull()
  })
})

describe('pickDisplayableFaviconUrl', () => {
  it('skips leading entries that cannot render', () => {
    expect(pickDisplayableFaviconUrl(['data:,', 'https://example.com/icon.png'])).toBe(
      'https://example.com/icon.png'
    )
  })

  it('keeps the declaration order among usable entries', () => {
    expect(
      pickDisplayableFaviconUrl([
        'https://github.githubassets.com/favicons/favicon.png',
        'https://github.githubassets.com/favicons/favicon.svg'
      ])
    ).toBe('https://github.githubassets.com/favicons/favicon.png')
  })

  it('reports nothing for an absent or unusable list', () => {
    expect(pickDisplayableFaviconUrl(undefined)).toBeNull()
    expect(pickDisplayableFaviconUrl([])).toBeNull()
    expect(pickDisplayableFaviconUrl(['data:,'])).toBeNull()
  })
})

describe('browserNavigationLeavesFaviconOrigin', () => {
  it('keeps the icon across a same-origin navigation', () => {
    expect(
      browserNavigationLeavesFaviconOrigin(
        'https://github.com/alibaba/jvm-sandbox',
        'https://github.com/btraceio/btrace'
      )
    ).toBe(false)
  })

  it('drops the icon when the origin changes', () => {
    expect(
      browserNavigationLeavesFaviconOrigin('https://github.com/nodejs/node', 'https://x.com/home')
    ).toBe(true)
  })

  it('treats scheme and port as part of the origin', () => {
    expect(
      browserNavigationLeavesFaviconOrigin('http://localhost:3000/', 'http://localhost:4000/')
    ).toBe(true)
    expect(
      browserNavigationLeavesFaviconOrigin('http://example.com/', 'https://example.com/')
    ).toBe(true)
  })

  it('drops the icon when the destination cannot carry one', () => {
    expect(browserNavigationLeavesFaviconOrigin('https://github.com/', 'about:blank')).toBe(true)
    expect(
      browserNavigationLeavesFaviconOrigin('https://github.com/', 'file:///tmp/report.html')
    ).toBe(true)
  })

  it('keeps the icon when the document being left is unknown', () => {
    expect(browserNavigationLeavesFaviconOrigin(null, 'https://github.com/nodejs/node')).toBe(false)
    expect(browserNavigationLeavesFaviconOrigin('about:blank', 'https://github.com/')).toBe(false)
  })
})
