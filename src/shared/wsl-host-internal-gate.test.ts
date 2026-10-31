import { describe, expect, it } from 'vitest'
import { isWslHostsInternalGateOpen, WSL_HOSTS_INTERNAL_GATE_ENV } from './wsl-host-internal-gate'

describe('WSL hosts internal gate', () => {
  it('is open when the variable is unset', () => {
    expect(isWslHostsInternalGateOpen({})).toBe(true)
  })

  it.each(['0', 'false', 'off', 'no', 'FALSE', ' Off ', 'No\n'])('is closed for %j', (value) => {
    expect(isWslHostsInternalGateOpen({ [WSL_HOSTS_INTERNAL_GATE_ENV]: value })).toBe(false)
  })

  // Empty reads like unset; anything else that isn't an off word keeps today's internal "on".
  it.each(['1', 'true', 'on', 'yes', '', '  ', 'disabled'])('is open for %j', (value) => {
    expect(isWslHostsInternalGateOpen({ [WSL_HOSTS_INTERNAL_GATE_ENV]: value })).toBe(true)
  })
})
