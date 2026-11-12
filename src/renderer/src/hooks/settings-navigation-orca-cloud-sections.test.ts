import { Bot } from 'lucide-react'
import type { SettingsNavSection } from '@/components/settings/navigation/settings-navigation-types'
import type { OrcaProfileAuthStatus } from '../../../shared/orca-profiles'
import { describe, expect, it } from 'vitest'
import { buildSetupSettingsSections } from './settings-navigation-capability-sections'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'
import {
  buildOrcaCloudSettingsSections,
  gatherOrcaCloudSettingsGroup,
  resolveAccountBillingTarget,
  labelAccountBilling,
  hasOrcaBillingAccount,
  ACCOUNT_BILLING_PLAN_ANCHOR
} from './settings-navigation-orca-cloud-sections'

function options(patch: Partial<SettingsNavigationBuildOptions>): SettingsNavigationBuildOptions {
  return {
    isMac: true,
    isWindows: false,
    isLocalWindowsHost: false,
    isWindowsTerminalHost: false,
    isWebClient: false,
    hostQueuesMessages: false,
    managedBrowserCreationEnabled: true,
    mobileEmulatorCreationEnabled: true,
    isDev: false,
    isLinearConnected: false,
    isOrcaCloudApiAvailable: true,
    repos: [],
    ...patch
  }
}

describe('Orca Cloud settings group', () => {
  it('holds every Orca Cloud pane, in order, when the build has a control plane', () => {
    const sections = buildOrcaCloudSettingsSections(options({}))
    expect(sections.map((section) => section.id)).toEqual([
      'cloud-billing',
      'cloud-team',
      'cloud-secrets',
      'cloud-skills',
      'cloud-environments',
      'cloud-mcp',
      'cloud-local-commands',
      'cloud-api-keys'
    ])
    // Routines are parked until they join Automations (cloud-routines-ui.ts): no section, no search.
    expect(
      sections
        .flatMap((section) => section.searchEntries ?? [])
        .some((e) => /routine/i.test(e.title))
    ).toBe(false)
    expect(new Set(sections.map((section) => section.group))).toEqual(new Set(['orca-cloud']))
  })

  it('is absent without a control plane and on the web client', () => {
    expect(buildOrcaCloudSettingsSections(options({ isOrcaCloudApiAvailable: false }))).toEqual([])
    expect(buildOrcaCloudSettingsSections(options({ isWebClient: true }))).toEqual([])
  })

  it('leaves Set Up with the account, and describes it by what it now holds', () => {
    const setup = buildSetupSettingsSections(options({}))
    expect(setup.some((section) => section.id.startsWith('cloud-'))).toBe(false)
    expect(setup.find((section) => section.id === 'orca-account')?.description).toBe(
      'The Orca account you’re signed in with.'
    )
    const gathered = gatherOrcaCloudSettingsGroup(setup, options({}))
    expect(gathered.find((section) => section.id === 'orca-account')?.description).toBe(
      'Your Orca account, plan, sandbox hours and payment.'
    )
    const local = buildSetupSettingsSections(options({ isOrcaCloudApiAvailable: false }))
    expect(local.find((section) => section.id === 'orca-account')?.description).not.toMatch(
      /Orca Cloud/
    )
  })
})

describe('one Orca Cloud group (JA-16)', () => {
  const nav = (id: string, group: SettingsNavSection['group']): SettingsNavSection => ({
    id,
    title: id,
    description: '',
    icon: Bot,
    searchEntries: [],
    group
  })

  const all = [
    nav('agents', 'capabilities'),
    nav('accounts', 'capabilities'),
    nav('orca-account', 'setup'),
    nav('general', 'setup'),
    nav('cloud-billing', 'orca-cloud'),
    nav('cloud-team', 'orca-cloud'),
    nav('automations', 'workflows')
  ]

  it('leads the Orca Cloud group with Account + Billing; Agent accounts stays in AI capabilities', () => {
    const out = gatherOrcaCloudSettingsGroup(all, options({}))
    expect(out.map((section) => `${section.group}:${section.id}`)).toEqual([
      'capabilities:agents',
      'capabilities:accounts',
      'setup:general',
      'orca-cloud:orca-account',
      'orca-cloud:cloud-team',
      'workflows:automations'
    ])
    expect(out.find((section) => section.id === 'orca-account')?.title).toBe('Account & billing')
  })

  it('moves Plan & billing search onto Account + Billing, landing on its billing part', () => {
    const withEntries = all.map((section) =>
      section.id === 'cloud-billing'
        ? { ...section, searchEntries: [{ title: 'Plan & billing', keywords: ['invoice'] }] }
        : section.id === 'orca-account'
          ? { ...section, searchEntries: [{ title: 'Orca account' }] }
          : section
    )
    const account = gatherOrcaCloudSettingsGroup(withEntries, options({})).find(
      (section) => section.id === 'orca-account'
    )
    expect(account?.searchEntries).toEqual([
      { title: 'Orca account' },
      {
        title: 'Plan & billing',
        keywords: ['invoice'],
        targetSectionId: ACCOUNT_BILLING_PLAN_ANCHOR
      }
    ])
  })

  it('is "Account" with no billing to show, and leaves the upstream account alone', () => {
    const gathered = gatherOrcaCloudSettingsGroup(all, options({}))
    const label = (sections: SettingsNavSection[]) =>
      sections.find((section) => section.id === 'orca-account')?.title
    expect(label(labelAccountBilling(gathered, true))).toBe('Account & billing')
    expect(label(labelAccountBilling(gathered, false))).toBe('Account')
    // Without Orca Cloud the account stays in Set Up with its own title.
    expect(label(labelAccountBilling(all, false))).toBe('orca-account')
  })

  it('has billing only when signed in with the billing capability', () => {
    const connected = (billing: boolean): OrcaProfileAuthStatus => ({
      activeProfileId: 'p',
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      capabilities: { flags: { billing }, refreshedAt: 0 }
    })
    expect(hasOrcaBillingAccount({ orcaProfileAuthStatus: connected(true) })).toBe(true)
    expect(hasOrcaBillingAccount({ orcaProfileAuthStatus: connected(false) })).toBe(false)
    expect(hasOrcaBillingAccount({ orcaProfileAuthStatus: null })).toBe(false)
  })

  it('sends old Plan & billing links to Account + Billing at its billing part', () => {
    expect(resolveAccountBillingTarget({ pane: 'cloud-billing' }, true)).toEqual({
      pane: 'orca-account',
      sectionId: ACCOUNT_BILLING_PLAN_ANCHOR
    })
    expect(resolveAccountBillingTarget({ pane: 'cloud-billing' }, false)).toEqual({
      pane: 'cloud-billing'
    })
    expect(resolveAccountBillingTarget({ pane: 'cloud-team' }, true)).toEqual({
      pane: 'cloud-team'
    })
  })

  it('leaves the upstream grouping alone without Orca Cloud', () => {
    expect(gatherOrcaCloudSettingsGroup(all, options({ isOrcaCloudApiAvailable: false }))).toEqual(
      all
    )
    expect(gatherOrcaCloudSettingsGroup(all, options({ isWebClient: true }))).toEqual(all)
  })
})

describe('isOrcaCloudSettingsSectionId', () => {
  it('is true only for the Orca Cloud group pages', async () => {
    const { isOrcaCloudSettingsSectionId } =
      await import('./settings-navigation-orca-cloud-sections')
    expect(isOrcaCloudSettingsSectionId('cloud-billing')).toBe(true)
    expect(isOrcaCloudSettingsSectionId('cloud-team')).toBe(true)
    expect(isOrcaCloudSettingsSectionId('orca-account')).toBe(true)
    expect(isOrcaCloudSettingsSectionId('general')).toBe(false)
    expect(isOrcaCloudSettingsSectionId('terminal')).toBe(false)
    expect(isOrcaCloudSettingsSectionId(null)).toBe(false)
  })
})
