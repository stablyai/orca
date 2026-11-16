import { describe, expect, it } from 'vitest'
import { resolveZotzComputerAwakeMode, resolveZotzMachineMode } from './zotz-machine-mode'

describe('zotz machine mode', () => {
  it('treats a missing or unknown persisted mode as unset so the wizard shows', () => {
    expect(resolveZotzMachineMode(undefined)).toBe('unset')
    expect(resolveZotzMachineMode({})).toBe('unset')
    expect(resolveZotzMachineMode({ zotzMachineMode: 'bogus' as never })).toBe('unset')
    expect(resolveZotzMachineMode({ zotzMachineMode: 'server' })).toBe('server')
  })

  it('keeps a server awake regardless of the awake preference', () => {
    expect(
      resolveZotzComputerAwakeMode({ zotzMachineMode: 'server', computerAwakeMode: 'off' })
    ).toBe('on')
    expect(
      resolveZotzComputerAwakeMode({ zotzMachineMode: 'personal', computerAwakeMode: 'off' })
    ).toBe('off')
    expect(
      resolveZotzComputerAwakeMode({ zotzMachineMode: 'unset', computerAwakeMode: 'auto' })
    ).toBe('auto')
  })
})
