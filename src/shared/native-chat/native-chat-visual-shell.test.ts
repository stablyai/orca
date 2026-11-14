import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
  NATIVE_CHAT_VISUAL_PING_TYPE,
  NATIVE_CHAT_VISUAL_PONG_TYPE,
  NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE,
  NATIVE_CHAT_VISUAL_SIZE_TYPE,
  buildNativeChatVisualDocument,
  nativeChatVisualThemeCss,
  readNativeChatVisualFrameMessage,
  readNativeChatVisualPong
} from './native-chat-visual-shell'

const theme = {
  colorScheme: 'dark' as const,
  tokens: { '--background': 'oklch(0.2 0 0)', '--chart-1': '#123456' }
}

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
