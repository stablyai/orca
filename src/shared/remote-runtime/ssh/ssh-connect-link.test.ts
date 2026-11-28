import { describe, expect, it } from 'vitest'
import { parseSshConnectLink } from './ssh-connect-link'

describe('parseSshConnectLink', () => {
  it('accepts exactly one plain Host alias, never an ssh option or a pattern', () => {
    expect(parseSshConnectLink('orca://ssh/connect?alias=instabox-orca_e2e.1')).toEqual({
      alias: 'instabox-orca_e2e.1'
    })
    expect(parseSshConnectLink('orca://ssh/connect/?alias=box')).toEqual({ alias: 'box' })
    expect(parseSshConnectLink('orca://ssh/connect?alias=-oProxyCommand=x')).toBeNull()
    expect(parseSshConnectLink('orca://ssh/connect?alias=%2DoProxyCommand%3Dx')).toBeNull()
    expect(parseSshConnectLink('orca://ssh/connect?alias=box%0A-oProxyCommand=x')).toBeNull()
    expect(parseSshConnectLink('orca://ssh/connect?alias=box+-F')).toBeNull()
    expect(parseSshConnectLink('orca://ssh/connect?alias=box*')).toBeNull()
    expect(parseSshConnectLink('orca://ssh/connect?alias=')).toBeNull()
    expect(parseSshConnectLink(`orca://ssh/connect?alias=${'a'.repeat(65)}`)).toBeNull()
    expect(parseSshConnectLink('orca://ssh/connect?alias=box&alias=other')).toBeNull()
    expect(parseSshConnectLink('orca://ssh/connect?alias=box&user=root')).toBeNull()
    expect(parseSshConnectLink('orca://ssh/connect?alias=box#x')).toBeNull()
    expect(parseSshConnectLink('orca://ssh/open?alias=box')).toBeNull()
    expect(parseSshConnectLink('orca://plugins/connect?alias=box')).toBeNull()
    expect(parseSshConnectLink('https://ssh/connect?alias=box')).toBeNull()
  })
})
