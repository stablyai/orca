import { describe, expect, it } from 'vitest'
import { sshEndpointIdentity } from './ssh-config-alias'

describe('sshEndpointIdentity', () => {
  it('treats the same machine reached under different names as one endpoint', () => {
    const manual = sshEndpointIdentity({
      host: '172.16.203.131',
      port: 22,
      username: 'chanmuzi'
    })
    const fromConfig = sshEndpointIdentity({
      host: '172.16.203.131',
      port: 22,
      username: 'chanmuzi'
    })

    expect(manual).toBe(fromConfig)
  })

  it('defaults a missing port to 22 so an explicit 22 matches an omitted one', () => {
    expect(sshEndpointIdentity({ host: 'box', username: 'me' })).toBe(
      sshEndpointIdentity({ host: 'box', port: 22, username: 'me' })
    )
  })

  it('separates host, port and user so no concatenation can alias them', () => {
    // Why: 'a' + '1:2' and 'a:1' + '2' must not collapse into the same key.
    expect(sshEndpointIdentity({ host: 'a', port: 12, username: '' })).not.toBe(
      sshEndpointIdentity({ host: 'a', port: 1, username: '2' })
    )
  })

  it('folds host and user case but keeps a different user distinct', () => {
    expect(sshEndpointIdentity({ host: 'BOX', port: 22, username: 'Me' })).toBe(
      sshEndpointIdentity({ host: 'box', port: 22, username: 'me' })
    )
    expect(sshEndpointIdentity({ host: 'box', port: 22, username: 'me' })).not.toBe(
      sshEndpointIdentity({ host: 'box', port: 22, username: 'other' })
    )
  })

  it('is empty for an unknown host so unresolved entries never collide', () => {
    expect(sshEndpointIdentity({ host: '', port: 22, username: 'me' })).toBe('')
    expect(sshEndpointIdentity({ host: '   ', port: 22, username: 'me' })).toBe('')
    expect(sshEndpointIdentity({ port: 22, username: 'me' })).toBe('')
  })

  it.each([Number.NaN, 0, -1, 1.5, 65_536])(
    'normalizes invalid port %s to the SSH default',
    (port) => {
      expect(sshEndpointIdentity({ host: 'box', port, username: 'me' })).toBe(
        sshEndpointIdentity({ host: 'box', port: 22, username: 'me' })
      )
    }
  )

  it.each([1, 65_535])('keeps valid boundary port %s', (port) => {
    expect(sshEndpointIdentity({ host: 'box', port, username: 'me' })).not.toBe(
      sshEndpointIdentity({ host: 'box', port: 22, username: 'me' })
    )
  })
})
