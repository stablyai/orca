import { describe, expect, it } from 'vitest'
import {
  resolveZotzComputerAwakeMode,
  resolveZotzMachineMode,
  shouldAutoShowZotzMachineModeWizard
} from './zotz-machine-mode'

describe('zotz machine mode', () => {
  it('treats a missing or unknown persisted mode as unset so the wizard shows', () => {
    expect(resolveZotzMachineMode(undefined)).toBe('unset')
    expect(resolveZotzMachineMode({})).toBe('unset')
    expect(resolveZotzMachineMode(JSON.parse('{"zotzMachineMode":"bogus"}'))).toBe('unset')
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

  it('keeps the wizard out of e2e and dev launches unless dev opts back in', () => {
    const show = (e2eUserDataDir: string | undefined, devBuild: boolean, flag?: string) =>
      shouldAutoShowZotzMachineModeWizard({ e2eUserDataDir, devBuild, showFirstRunEducation: flag })
    expect(show(undefined, false)).toBe(true)
    expect(show('/tmp/e2e-profile', false)).toBe(false)
    expect(show(undefined, true)).toBe(false)
    expect(show(undefined, true, '1')).toBe(true)
    expect(show('/tmp/e2e-profile', true, '1')).toBe(false)
  })
})
