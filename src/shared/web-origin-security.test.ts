import { describe, expect, it } from 'vitest'
import { withWebClientUpgradeMarker } from './web-origin-security'

describe('web client upgrade marker', () => {
  it('adds itself to the endpoint the web bundle dials', () => {
    expect(withWebClientUpgradeMarker('ws://192.168.1.20:6768')).toBe(
      'ws://192.168.1.20:6768/?orca-client=web'
    )
    expect(withWebClientUpgradeMarker('wss://desk.example.com/orca?x=1')).toBe(
      'wss://desk.example.com/orca?x=1&orca-client=web'
    )
  })

  it('leaves an unparseable endpoint alone', () => {
    expect(withWebClientUpgradeMarker('not a url')).toBe('not a url')
  })
})
