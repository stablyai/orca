import { describe, expect, it } from 'vitest'
import { loopbackOAuthRedirectPort } from './loopback-oauth-redirect'

const authorize = (redirect: string, extra = '&client_id=abc&response_type=code'): string =>
  `https://mcp.example.com/authorize?redirect_uri=${encodeURIComponent(redirect)}${extra}`

describe('loopbackOAuthRedirectPort', () => {
  it('returns the port of a loopback http redirect', () => {
    expect(loopbackOAuthRedirectPort(authorize('http://localhost:53682/callback'))).toBe(53682)
    expect(loopbackOAuthRedirectPort(authorize('http://127.0.0.1:41000/cb'))).toBe(41000)
    expect(loopbackOAuthRedirectPort(authorize('http://[::1]:41001/cb'))).toBe(41001)
  })

  it('ignores non-loopback, https, privileged or portless redirects and non-OAuth links', () => {
    expect(loopbackOAuthRedirectPort(authorize('https://localhost:53682/cb'))).toBeNull()
    expect(loopbackOAuthRedirectPort(authorize('http://evil.example:53682/cb'))).toBeNull()
    expect(loopbackOAuthRedirectPort(authorize('http://localhost:80/cb'))).toBeNull()
    expect(loopbackOAuthRedirectPort(authorize('http://localhost/cb'))).toBeNull()
    expect(loopbackOAuthRedirectPort(authorize('http://localhost:53682/cb', ''))).toBeNull()
    expect(loopbackOAuthRedirectPort('http://localhost:3000/?redirect_uri=x')).toBeNull()
    expect(loopbackOAuthRedirectPort('not a url')).toBeNull()
  })
})
