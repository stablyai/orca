import { describe, expect, it } from 'vitest'
import {
  applyVoloRefreshTokens,
  parseStoredVoloSecret,
  parseVoloGoogleCallbackSearch,
  parseVoloGoogleSession,
  sessionAccessExpired,
  voloGoogleCliAuthorizeUrl
} from './volo-google-session'

describe('volo google session', () => {
  it('builds the CLI Google authorize URL', () => {
    expect(voloGoogleCliAuthorizeUrl('https://volo.api.jaak.ai/')).toBe(
      'https://volo.api.jaak.ai/api/auth/cli/google'
    )
  })

  it('parses the CLI Google callback query', () => {
    const session = parseVoloGoogleCallbackSearch(
      '?accessToken=jwt&refreshToken=rt&expiresIn=3600&userId=u1&email=ada@jaak.ai&name=Ada',
      1_000
    )
    expect(session).toEqual({
      accessToken: 'jwt',
      refreshToken: 'rt',
      expiresAt: 3_601_000,
      userId: 'u1',
      email: 'ada@jaak.ai',
      name: 'Ada'
    })
  })

  it('surfaces Volo Google callback errors', () => {
    expect(() =>
      parseVoloGoogleCallbackSearch('?error=not_authorized&message=Your+email+is+not+authorized')
    ).toThrow(/not authorized/)
  })

  it('reads ~/.jaak-volo/credentials.json and legacy raw tokens', () => {
    expect(
      parseVoloGoogleSession({
        accessToken: 'jwt',
        refreshToken: 'rt',
        expiresAt: 9,
        userId: 'u1',
        email: 'ada@jaak.ai',
        name: 'Ada'
      })
    ).toMatchObject({ accessToken: 'jwt', refreshToken: 'rt', userId: 'u1' })
    expect(parseStoredVoloSecret('jk_legacy')).toMatchObject({
      accessToken: 'jk_legacy',
      refreshToken: ''
    })
  })

  it('applies rotated refresh tokens', () => {
    const next = applyVoloRefreshTokens(
      {
        accessToken: 'old',
        refreshToken: 'old-rt',
        expiresAt: 1,
        userId: 'u1',
        email: 'ada@jaak.ai',
        name: 'Ada'
      },
      { accessToken: 'new', refreshToken: 'new-rt', expiresIn: 120 },
      1_000
    )
    expect(next.accessToken).toBe('new')
    expect(next.refreshToken).toBe('new-rt')
    expect(next.expiresAt).toBe(121_000)
    expect(sessionAccessExpired(next, 1_000)).toBe(false)
    expect(sessionAccessExpired(next, 121_000)).toBe(true)
  })
})
