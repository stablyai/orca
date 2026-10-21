import { describe, expect, it } from 'vitest'
import {
  getMachineDisplayState,
  getMachineDisplayStateLabel,
  machineNeedsWake
} from './machine-display-state'

describe('machine display state', () => {
  it('shows a sleep still in progress as Sleeping… and lets opening it wake the machine', () => {
    expect(getMachineDisplayState('stopping')).toBe('stopping')
    expect(getMachineDisplayStateLabel('stopping')).toBe('Sleeping…')
    expect(machineNeedsWake('stopping')).toBe(true)
    expect(machineNeedsWake('running')).toBe(false)
  })

  it('gives a provider error its own state and reads states it does not know as unreachable', () => {
    expect(getMachineDisplayState('error')).toBe('error')
    expect(getMachineDisplayStateLabel('error')).toBe('Error')
    // Why: a newer paired server may send a state this build has never seen.
    expect(getMachineDisplayState('hibernating')).toBe('unreachable')
    expect(getMachineDisplayStateLabel(getMachineDisplayState('hibernating'))).toBe('Unreachable')
  })
})
