import { describe, expect, it } from 'vitest'
import { normalizeNodeDistMirrorUrl, resolveNodeDistMirror } from './node-dist-mirror'

describe('Node dist mirror URL', () => {
  it('keeps an http(s) base and drops trailing slashes', () => {
    expect(normalizeNodeDistMirrorUrl(' https://npmmirror.com/mirrors/node/ ')).toEqual({
      ok: true,
      value: 'https://npmmirror.com/mirrors/node'
    })
    expect(normalizeNodeDistMirrorUrl('')).toEqual({ ok: true, value: '' })
    for (const empty of [
      'https://m.example/dist?',
      'https://m.example/dist#',
      'https://m.example/dist/?#'
    ]) {
      expect(normalizeNodeDistMirrorUrl(empty)).toEqual({
        ok: true,
        value: 'https://m.example/dist'
      })
    }
  })

  it.each([
    ['ftp://mirror.example.com/node', 'http or https', 'protocol'],
    ['https://user:secret@mirror.example.com/node', 'user name or password', 'credentials'],
    ['https://mirror.example.com/node?token=1', 'query', 'query'],
    ['not a url', 'valid mirror URL', 'invalid'],
    [`https://m.example/${'a'.repeat(2048)}`, 'too long', 'too-long']
  ])('refuses %s', (value, message, reason) => {
    expect(normalizeNodeDistMirrorUrl(value)).toMatchObject({
      ok: false,
      message: expect.stringContaining(message),
      reason
    })
  })

  it('prefers the setting, then NODEJS_ORG_MIRROR, then NVM_NODEJS_ORG_MIRROR', () => {
    const env = {
      NODEJS_ORG_MIRROR: 'https://a.example/dist',
      NVM_NODEJS_ORG_MIRROR: 'https://b.example/dist'
    }
    expect(resolveNodeDistMirror('https://setting.example/dist', env)).toBe(
      'https://setting.example/dist'
    )
    expect(resolveNodeDistMirror('', env)).toBe('https://a.example/dist')
    expect(resolveNodeDistMirror(undefined, { NVM_NODEJS_ORG_MIRROR: 'https://b.example/' })).toBe(
      'https://b.example'
    )
    expect(resolveNodeDistMirror('nonsense', {})).toBeNull()
  })
})
