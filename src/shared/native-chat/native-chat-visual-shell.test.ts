import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_CSP,
  NATIVE_CHAT_VISUAL_HOST_CSP,
  NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
  NATIVE_CHAT_VISUAL_PING_TYPE,
  NATIVE_CHAT_VISUAL_PONG_TYPE,
  NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE,
  NATIVE_CHAT_VISUAL_SIZE_TYPE,
  buildNativeChatVisualDocument,
  nativeChatVisualPingMessage,
  nativeChatVisualThemeCss,
  readNativeChatVisualFrameMessage,
  readNativeChatVisualPong
} from './native-chat-visual-shell'

const theme = {
  colorScheme: 'dark' as const,
  tokens: { '--background': 'oklch(0.2 0 0)', '--chart-1': '#123456' }
}

function directives(policy = NATIVE_CHAT_VISUAL_CSP): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
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

describe('NATIVE_CHAT_VISUAL_HOST_CSP', () => {
  it('is the visual policy except that it admits only an about: base, for the shell', () => {
    const host = directives(NATIVE_CHAT_VISUAL_HOST_CSP)
    const visual = directives()
    expect(host.get('base-uri')).toBe('about:')
    expect(visual.get('base-uri')).toBe("'none'")
    host.delete('base-uri')
    visual.delete('base-uri')
    expect(host).toEqual(visual)
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

  it('resolves in-page links against the visual itself, ahead of the policy that bars any other base', () => {
    const baseAt = document.indexOf('<base href="about:srcdoc">')
    expect(baseAt).toBeGreaterThan(0)
    expect(baseAt).toBeLessThan(document.indexOf('http-equiv="Content-Security-Policy"'))
    // A srcdoc page otherwise resolves '#x' against Orca's own URL and navigates away.
    expect(new URL('#overview', 'about:srcdoc').href).toBe('about:srcdoc#overview')
    expect(() => new URL('page-2.html', 'about:srcdoc')).toThrow()
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

  it('accepts a wheel with a finite nonzero delta and a touch drag', () => {
    const scroll = { type: NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE, channel: 'c' }
    expect(
      readNativeChatVisualFrameMessage({ ...scroll, input: 'wheel', deltaY: -30 }, 'c')
    ).toEqual({ kind: 'reader-scroll', input: 'wheel', deltaY: -30 })
    expect(readNativeChatVisualFrameMessage({ ...scroll, input: 'touch' }, 'c')).toEqual({
      kind: 'reader-scroll',
      input: 'touch'
    })
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
    [
      'zero wheel delta',
      { type: NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE, channel: 'c', input: 'wheel', deltaY: 0 }
    ],
    [
      'NaN wheel delta',
      {
        type: NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE,
        channel: 'c',
        input: 'wheel',
        deltaY: Number.NaN
      }
    ],
    [
      'string wheel delta',
      { type: NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE, channel: 'c', input: 'wheel', deltaY: '-3' }
    ],
    [
      'unknown input',
      { type: NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE, channel: 'c', input: 'key', deltaY: -3 }
    ],
    ['unknown type', { type: 'orca-panel-action', channel: 'c' }],
    ['a string', 'orca-visual-size'],
    ['null', null]
  ])('refuses %s', (_name, data) => {
    expect(readNativeChatVisualFrameMessage(data, 'c')).toBeNull()
  })
})

describe('readNativeChatVisualPong', () => {
  it('reads the ping id on its own channel', () => {
    const pong = { type: NATIVE_CHAT_VISUAL_PONG_TYPE, channel: 'c', id: 2 }
    expect(readNativeChatVisualPong(pong, 'c')).toBe(2)
    expect(nativeChatVisualPingMessage(2, 'c')).toEqual({
      type: NATIVE_CHAT_VISUAL_PING_TYPE,
      channel: 'c',
      id: 2
    })
  })

  it.each([
    ['another channel', { type: NATIVE_CHAT_VISUAL_PONG_TYPE, channel: 'x', id: 2 }],
    ['a ping', { type: NATIVE_CHAT_VISUAL_PING_TYPE, channel: 'c', id: 2 }],
    ['no id', { type: NATIVE_CHAT_VISUAL_PONG_TYPE, channel: 'c' }],
    ['a fractional id', { type: NATIVE_CHAT_VISUAL_PONG_TYPE, channel: 'c', id: 1.5 }],
    ['a string id', { type: NATIVE_CHAT_VISUAL_PONG_TYPE, channel: 'c', id: '2' }],
    ['null', null]
  ])('refuses %s', (_name, data) => {
    expect(readNativeChatVisualPong(data, 'c')).toBeNull()
  })
})
