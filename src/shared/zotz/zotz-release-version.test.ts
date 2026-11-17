import { describe, expect, it } from 'vitest'
import { describeZotzVersion } from './zotz-release-version'

describe('describeZotzVersion', () => {
  it('reads the Orca base and Zotz build, and leaves plain Orca versions alone', () => {
    expect(describeZotzVersion('1.4.21427')).toEqual({ orcaBase: '1.4.214', build: 27 })
    expect(describeZotzVersion('1.4.214')).toBeNull()
    expect(describeZotzVersion('1.4.214-rc.1')).toBeNull()
  })
})
