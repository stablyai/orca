import { describe, expect, it } from 'vitest'
import { parseTerminalHostStamp, readTerminalHostStamp } from './terminal-host-stamp'

describe('readTerminalHostStamp', () => {
  it('reads no stamp from an entry without the setup key, whatever host it names', () => {
    expect(readTerminalHostStamp({})).toBeNull()
    expect(readTerminalHostStamp({ executionHostId: 'runtime:env-a' })).toBeNull()
  })

  it.each([['setup-1'], [42], [null], [''], ['  '], [{ nested: true }]])(
    'carries a present setup value %j verbatim, with or without a host',
    (setup) => {
      expect(readTerminalHostStamp({ projectHostSetupId: setup })).toEqual({ setup })
      expect(
        readTerminalHostStamp({ executionHostId: 'runtime:env-a', projectHostSetupId: setup })
      ).toEqual({ setup, executionHostId: 'runtime:env-a' })
    }
  )
})

describe('parseTerminalHostStamp', () => {
  it.each([[42], [null], [''], ['  '], [undefined], [{ id: 'setup-1' }]])(
    'refuses a setup value %j as missing_setup',
    (setup) => {
      expect(parseTerminalHostStamp(setup, 'runtime:env-a')).toEqual({
        kind: 'invalid',
        reason: 'missing_setup'
      })
    }
  )

  it.each([['local'], ['ssh:box'], [undefined], [null], [42], ['runtime:'], ['runtime:%20']])(
    'refuses a host %j that is not a runtime as host_not_runtime',
    (host) => {
      expect(parseTerminalHostStamp('setup-1', host)).toEqual({
        kind: 'invalid',
        reason: 'host_not_runtime'
      })
    }
  )

  it('reads a runtime host and a setup id as a stamp naming the saved environment', () => {
    expect(parseTerminalHostStamp('setup-1', 'runtime:env-a')).toEqual({
      kind: 'stamped',
      environmentId: 'env-a',
      executionHostId: 'runtime:env-a',
      projectHostSetupId: 'setup-1'
    })
  })
})
