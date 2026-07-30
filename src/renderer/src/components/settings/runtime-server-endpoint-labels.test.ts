import { describe, expect, it } from 'vitest'
import { getRuntimeServerListEndpointDisplay } from './runtime-server-endpoint-labels'

describe('getRuntimeServerListEndpointDisplay', () => {
  it('omits the server-list endpoint row when no endpoint exists', () => {
    expect(getRuntimeServerListEndpointDisplay(null)).toBeNull()
  })

  it('returns the endpoint when the server-list row has one', () => {
    expect(getRuntimeServerListEndpointDisplay('ws://100.64.0.5:6768')).toBe('ws://100.64.0.5:6768')
  })
})
