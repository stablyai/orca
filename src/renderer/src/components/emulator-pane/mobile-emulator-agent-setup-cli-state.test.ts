import { describe, expect, it } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import {
  getMobileEmulatorCliPathNeedsAttention,
  getMobileEmulatorCliStepBadgeState,
  shouldShowMobileEmulatorSkillPreInstallNotice
} from './mobile-emulator-agent-setup-cli-state'

function cliStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca.app/Contents/MacOS/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

describe('getMobileEmulatorCliPathNeedsAttention', () => {
  it('flags installed CLIs that are not visible on PATH yet', () => {
    expect(getMobileEmulatorCliPathNeedsAttention(cliStatus({ pathConfigured: false }))).toBe(true)
    expect(getMobileEmulatorCliPathNeedsAttention(cliStatus())).toBe(false)
    expect(getMobileEmulatorCliPathNeedsAttention(cliStatus({ state: 'not_installed' }))).toBe(
      false
    )
  })
})

describe('getMobileEmulatorCliStepBadgeState', () => {
  it('marks enabled CLIs as done', () => {
    expect(
      getMobileEmulatorCliStepBadgeState({
        cliBusy: false,
        cliEnabled: true,
        cliPathNeedsAttention: false
      })
    ).toBe('done')
  })

  it('marks PATH-fix and registration flows as in progress', () => {
    expect(
      getMobileEmulatorCliStepBadgeState({
        cliBusy: true,
        cliEnabled: false,
        cliPathNeedsAttention: false
      })
    ).toBe('in-progress')
    expect(
      getMobileEmulatorCliStepBadgeState({
        cliBusy: false,
        cliEnabled: false,
        cliPathNeedsAttention: true
      })
    ).toBe('in-progress')
  })
})

describe('shouldShowMobileEmulatorSkillPreInstallNotice', () => {
  it('hides the prereq notice once either step is already complete', () => {
    expect(
      shouldShowMobileEmulatorSkillPreInstallNotice({
        cliEnabled: true,
        cliSkillInstalled: false
      })
    ).toBe(false)
    expect(
      shouldShowMobileEmulatorSkillPreInstallNotice({
        cliEnabled: false,
        cliSkillInstalled: true
      })
    ).toBe(false)
    expect(
      shouldShowMobileEmulatorSkillPreInstallNotice({
        cliEnabled: false,
        cliSkillInstalled: false
      })
    ).toBe(true)
  })
})
