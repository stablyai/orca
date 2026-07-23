import { describe, expect, it } from 'vitest'
import { describeAppVersionSkew, evaluateAppVersionSkew, parseAppVersion } from './app-version-skew'

describe('evaluateAppVersionSkew', () => {
  it('returns null when client and server versions match', () => {
    expect(
      evaluateAppVersionSkew({ clientAppVersion: '1.4.147', serverAppVersion: '1.4.147' })
    ).toBeNull()
  })

  it('flags a server running behind the client', () => {
    expect(
      evaluateAppVersionSkew({ clientAppVersion: '1.4.147', serverAppVersion: '1.4.146' })
    ).toEqual({
      direction: 'server-older',
      clientAppVersion: '1.4.147',
      serverAppVersion: '1.4.146'
    })
  })

  it('flags a server running ahead of the client', () => {
    expect(
      evaluateAppVersionSkew({ clientAppVersion: '1.4.147', serverAppVersion: '1.5.0' })
    ).toEqual({
      direction: 'server-newer',
      clientAppVersion: '1.4.147',
      serverAppVersion: '1.5.0'
    })
  })

  it('treats a server that reports no version as older', () => {
    expect(evaluateAppVersionSkew({ clientAppVersion: '1.4.147', serverAppVersion: null })).toEqual(
      {
        direction: 'server-older',
        clientAppVersion: '1.4.147',
        serverAppVersion: null
      }
    )
  })

  it('ranks a release above its own release candidates', () => {
    expect(
      evaluateAppVersionSkew({ clientAppVersion: '1.4.124', serverAppVersion: '1.4.124-rc.1' })
    ).toMatchObject({ direction: 'server-older' })
    expect(
      evaluateAppVersionSkew({ clientAppVersion: '1.4.124-rc.1', serverAppVersion: '1.4.124' })
    ).toMatchObject({ direction: 'server-newer' })
  })

  it('orders release candidates numerically', () => {
    expect(
      evaluateAppVersionSkew({
        clientAppVersion: '1.4.124-rc.10',
        serverAppVersion: '1.4.124-rc.2'
      })
    ).toMatchObject({ direction: 'server-older' })
  })

  it('stays silent when the client version is unknown or unparseable', () => {
    expect(
      evaluateAppVersionSkew({ clientAppVersion: null, serverAppVersion: '1.4.146' })
    ).toBeNull()
    expect(
      evaluateAppVersionSkew({ clientAppVersion: 'dev', serverAppVersion: '1.4.146' })
    ).toBeNull()
  })

  it('stays silent when the server version is present but unparseable', () => {
    expect(
      evaluateAppVersionSkew({ clientAppVersion: '1.4.147', serverAppVersion: 'weird-build' })
    ).toBeNull()
  })

  it('ignores build metadata when comparing', () => {
    expect(
      evaluateAppVersionSkew({
        clientAppVersion: '1.4.147+abc123',
        serverAppVersion: '1.4.147+def456'
      })
    ).toBeNull()
  })
})

describe('parseAppVersion', () => {
  it('parses release and prerelease forms', () => {
    expect(parseAppVersion('1.4.147')).toEqual({ release: [1, 4, 147], prerelease: null })
    expect(parseAppVersion('1.4.124-rc.1')).toEqual({
      release: [1, 4, 124],
      prerelease: ['rc', '1']
    })
  })

  it('rejects malformed versions', () => {
    expect(parseAppVersion('')).toBeNull()
    expect(parseAppVersion(undefined)).toBeNull()
    expect(parseAppVersion('1.4')).toBeNull()
    expect(parseAppVersion('v1.4.147')).toBeNull()
  })
})

describe('describeAppVersionSkew', () => {
  it('tells the user to update the server when it is older', () => {
    expect(
      describeAppVersionSkew({
        direction: 'server-older',
        clientAppVersion: '1.4.147',
        serverAppVersion: '1.4.146'
      })
    ).toBe(
      'This Orca server (1.4.146) is older than your app (1.4.147). Update the server, or some features may fail.'
    )
  })

  it('handles servers that predate version reporting', () => {
    expect(
      describeAppVersionSkew({
        direction: 'server-older',
        clientAppVersion: '1.4.147',
        serverAppVersion: null
      })
    ).toBe(
      'This Orca server is older than your app (1.4.147). Update the server, or some features may fail.'
    )
  })

  it('tells the user to update the app when the server is newer', () => {
    expect(
      describeAppVersionSkew({
        direction: 'server-newer',
        clientAppVersion: '1.4.146',
        serverAppVersion: '1.4.147'
      })
    ).toBe(
      'This Orca server (1.4.147) is newer than your app (1.4.146). Update this app, or some features may fail.'
    )
  })
})
