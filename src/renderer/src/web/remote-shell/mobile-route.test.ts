import { describe, expect, it } from 'vitest'
import { isMobileRemotePath, parseMobileRemoteHash } from './mobile-route'

describe('isMobileRemotePath', () => {
  it.each(['/remote', '/remote/', '/orca/remote', '/orca/remote/'])(
    'recognizes the mobile shell path %s',
    (pathname) => {
      expect(isMobileRemotePath(pathname)).toBe(true)
    }
  )

  it.each(['/', '/web-index.html', '/remote/chat', '/notremote', '/remotely'])(
    'leaves non-shell paths on the desktop app: %s',
    (pathname) => {
      expect(isMobileRemotePath(pathname)).toBe(false)
    }
  )
})


describe('parseMobileRemoteHash', () => {
  it('reads the pairing offer and hostname from the fragment', () => {
    expect(parseMobileRemoteHash('#pairing=offer-123&name=Workstation')).toEqual({
      pairingInput: 'offer-123',
      hostName: 'Workstation'
    })
  })

  it('accepts the older token fragment and tolerates a missing hash', () => {
    expect(parseMobileRemoteHash('#token=secret')).toEqual({
      pairingInput: 'secret',
      hostName: null
    })
    expect(parseMobileRemoteHash('')).toEqual({ pairingInput: null, hostName: null })
  })
})
