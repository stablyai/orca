import { describe, expect, it } from 'vitest'
import { assignPeerPresenceColor } from './peer-presence-color'

describe('assignPeerPresenceColor', () => {
  it('returns the same color for the same clientId every time', () => {
    const clientId = 'peer-client-abc123'
    expect(assignPeerPresenceColor(clientId)).toBe(assignPeerPresenceColor(clientId))
  })

  it('is deterministic across process boundaries (no Math.random / Date.now)', () => {
    expect(assignPeerPresenceColor('fixed-id')).toBe('#eab308')
  })
})
