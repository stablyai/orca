import { describe, expect, it } from 'vitest'
import {
  formatWslHostsServeOnlyArgument,
  hasWslHostsServeOnlyArgument,
  resolveWslHostsGateState
} from './wsl-host-internal-gate'

describe('WSL hosts gate state', () => {
  it('is open whenever the internal gate is, whatever is saved', () => {
    for (const hasSavedWslHost of [false, true]) {
      for (const hasWslMoveCutover of [false, true]) {
        expect(
          resolveWslHostsGateState({ gateOpen: true, hasSavedWslHost, hasWslMoveCutover })
        ).toBe('open')
      }
    }
  })

  it('promotes a closed gate to serve-only for a saved host or a move journal entry, else stays closed', () => {
    const closed = { gateOpen: false, hasSavedWslHost: false, hasWslMoveCutover: false }
    expect(resolveWslHostsGateState(closed)).toBe('closed')
    expect(resolveWslHostsGateState({ ...closed, hasSavedWslHost: true })).toBe('serve-only')
    expect(resolveWslHostsGateState({ ...closed, hasWslMoveCutover: true })).toBe('serve-only')
  })

  it('reads back only the serve-only argument main stamps', () => {
    expect(hasWslHostsServeOnlyArgument(['--x', formatWslHostsServeOnlyArgument()])).toBe(true)
    expect(hasWslHostsServeOnlyArgument(['--orca-wsl-hosts-serve-only=0'])).toBe(false)
    expect(hasWslHostsServeOnlyArgument([])).toBe(false)
  })
})
