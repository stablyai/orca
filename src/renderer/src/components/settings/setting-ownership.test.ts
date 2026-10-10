import { describe, expect, it } from 'vitest'
import { getSettingOwnershipSummary } from './setting-ownership'

describe('getSettingOwnershipSummary', () => {
  it('documents Source Control AI as client defaults with host-scoped model choices', () => {
    const summary = getSettingOwnershipSummary('sourceControlAiDefaults')

    expect(summary.ownership).toBe('client-default')
    expect(summary.description).toContain('shared by this client')
    expect(summary.description).toContain('model choices and discovery stay scoped to the host')
  })

  it('documents repository Source Control AI as project-host setup scoped', () => {
    const summary = getSettingOwnershipSummary('repositorySourceControlAi')

    expect(summary.ownership).toBe('project-host-setup')
    expect(summary.description).toContain('this project setup')
  })

  it('documents agent launch defaults as owned by the selected execution host', () => {
    const summary = getSettingOwnershipSummary('agentLaunchDefaults')

    expect(summary.ownership).toBe('host-collection')
    expect(summary.description).toContain('saved on the selected host')
  })

  it('keeps workspace directories and provider accounts explicitly host-aware', () => {
    expect(getSettingOwnershipSummary('workspaceDirectory').ownership).toBe('host-override')
    expect(getSettingOwnershipSummary('providerAccounts').ownership).toBe('provider-host')
  })

  it('documents quick commands as host-owned collections', () => {
    const summary = getSettingOwnershipSummary('terminalQuickCommands')

    expect(summary.ownership).toBe('host-collection')
    expect(summary.description).toContain('selected Orca host')
    expect(summary.description).toContain('remain available in remote workspaces')
  })
})
