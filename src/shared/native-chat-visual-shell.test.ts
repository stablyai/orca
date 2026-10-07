import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_CSP,
  NATIVE_CHAT_VISUAL_MAX_HEIGHT,
  NATIVE_CHAT_VISUAL_MIN_HEIGHT,
  NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
  NATIVE_CHAT_VISUAL_SIZE_TYPE,
  NATIVE_CHAT_VISUAL_THEME_TYPE,
  buildNativeChatVisualDocument,
  clampNativeChatVisualHeight,
  nativeChatVisualThemeCss,
  nativeChatVisualThemeMessage,
  readNativeChatVisualFrameMessage
} from './native-chat-visual-shell'

const theme = {
  colorScheme: 'dark' as const,
  tokens: { '--background': 'oklch(0.2 0 0)', '--chart-1': '#123456' }
}

function directives(): Map<string, string> {
  return new Map(
    NATIVE_CHAT_VISUAL_CSP.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/)
      return [name, values.join(' ')]
    })
  )
}

describe('NATIVE_CHAT_VISUAL_CSP', () => {
  it('denies by default and closes every channel a chart does not need', () => {
    const policy = directives()
    expect(policy.get('default-src')).toBe("'none'")
    for (const name of [
      'connect-src',
      'frame-src',
      'child-src',
      'worker-src',
      'object-src',
      'media-src',
      'manifest-src',
      'form-action',
      'base-uri'
    ]) {
      expect(policy.get(name)).toBe("'none'")
    }
  })

  it('allows assets only inline, from data/blob, or from the pinned CDNs, and never eval', () => {
    const policy = directives()
    for (const name of ['script-src', 'style-src']) {
      expect(policy.get(name)).toContain("'unsafe-inline'")
      expect(policy.get(name)).not.toContain("'unsafe-eval'")
      expect(policy.get(name)).not.toContain('*')
    }
    expect(policy.get('img-src')).toBe(
      'data: blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh https://fonts.googleapis.com https://fonts.gstatic.com'
    )
  })
})

describe('buildNativeChatVisualDocument', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>'
  const document = buildNativeChatVisualDocument({ html, channel: 'abc123', theme })

  it('puts the CSP before anything the visual wrote', () => {
    const cspAt = document.indexOf('http-equiv="Content-Security-Policy"')
    expect(cspAt).toBeGreaterThan(0)
    expect(cspAt).toBeLessThan(document.indexOf('<title>x</title>'))
    expect(cspAt).toBeLessThan(document.indexOf('<script>'))
    expect(document.endsWith(html)).toBe(true)
  })

  it('paints the theme before the visual and carries the channel in the bootstrap', () => {
    expect(document).toContain('<html class="dark">')
    expect(document).toContain('--background:oklch(0.2 0 0)')
    expect(document).toContain('"channel":"abc123"')
  })

  it('checks the theme message comes from the host window', () => {
    expect(document).toContain('event.source !== host')
  })
})

describe('nativeChatVisualThemeCss', () => {
  it('drops structural characters and invalid names so a value cannot escape the rule', () => {
    const css = nativeChatVisualThemeCss({
      colorScheme: 'light',
      tokens: {
        '--background': 'red;}</style><script>alert(1)</script>',
        'not-a-token': 'blue',
        '--Upper': 'green'
      }
    })
    expect(css).not.toContain('</style>')
    expect(css).not.toContain('}<')
    expect(css).not.toContain('not-a-token')
    expect(css).not.toContain('--Upper')
    expect(css.startsWith(':root{color-scheme:light')).toBe(true)
  })

  it('builds the live theme message on the same channel', () => {
    expect(nativeChatVisualThemeMessage(theme, 'abc')).toMatchObject({
      type: NATIVE_CHAT_VISUAL_THEME_TYPE,
      channel: 'abc',
      colorScheme: 'dark'
    })
  })
})

describe('readNativeChatVisualFrameMessage', () => {
  it('accepts a finite size and an http(s) link on its own channel', () => {
    expect(
      readNativeChatVisualFrameMessage(
        { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel: 'c', height: 321.5 },
        'c'
      )
    ).toEqual({ kind: 'size', height: 321.5 })
    expect(
      readNativeChatVisualFrameMessage(
        { type: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE, channel: 'c', url: 'https://example.com/a b' },
        'c'
      )
    ).toEqual({ kind: 'open-link', url: 'https://example.com/a%20b' })
  })

  it.each([
    ['another channel', { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel: 'x', height: 10 }],
    ['no channel', { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, height: 10 }],
    ['NaN height', { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel: 'c', height: Number.NaN }],
    ['infinite height', { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel: 'c', height: Infinity }],
    ['negative height', { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel: 'c', height: -5 }],
    ['string height', { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, channel: 'c', height: '50' }],
    [
      'javascript link',
      { type: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE, channel: 'c', url: 'javascript:alert(1)' }
    ],
    ['file link', { type: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE, channel: 'c', url: 'file:///etc' }],
    [
      'overlong link',
      {
        type: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
        channel: 'c',
        url: `https://example.com/${'a'.repeat(3000)}`
      }
    ],
    ['unknown type', { type: 'orca-panel-action', channel: 'c' }],
    ['a string', 'orca-visual-size'],
    ['null', null]
  ])('refuses %s', (_name, data) => {
    expect(readNativeChatVisualFrameMessage(data, 'c')).toBeNull()
  })
})

describe('clampNativeChatVisualHeight', () => {
  it('keeps heights in range', () => {
    expect(clampNativeChatVisualHeight(1)).toBe(NATIVE_CHAT_VISUAL_MIN_HEIGHT)
    expect(clampNativeChatVisualHeight(99_999)).toBe(NATIVE_CHAT_VISUAL_MAX_HEIGHT)
    expect(clampNativeChatVisualHeight(300.4)).toBe(300)
  })
})
