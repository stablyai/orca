import { describe, expect, it } from 'vitest'
import {
  buildDefaultAgentSettingsUpdate,
  isNewWorkspaceSetupOnlyDefault
} from './new-workspace-setup-only'

describe('new workspace setup-only default', () => {
  it('stores "None" as a blank default plus the flag', () => {
    expect(buildDefaultAgentSettingsUpdate('setup-only')).toEqual({
      defaultTuiAgent: 'blank',
      newWorkspaceSetupOnly: true
    })
  })

  it('clears the flag when any other default is chosen', () => {
    expect(buildDefaultAgentSettingsUpdate('blank')).toEqual({
      defaultTuiAgent: 'blank',
      newWorkspaceSetupOnly: false
    })
    expect(buildDefaultAgentSettingsUpdate('claude')).toEqual({
      defaultTuiAgent: 'claude',
      newWorkspaceSetupOnly: false
    })
    expect(buildDefaultAgentSettingsUpdate(null)).toEqual({
      defaultTuiAgent: null,
      newWorkspaceSetupOnly: false
    })
  })

  it('honours the flag only alongside a blank default', () => {
    expect(
      isNewWorkspaceSetupOnlyDefault({ defaultTuiAgent: 'blank', newWorkspaceSetupOnly: true })
    ).toBe(true)
    // Another client may have switched the default to an agent without knowing the flag.
    expect(
      isNewWorkspaceSetupOnlyDefault({ defaultTuiAgent: 'claude', newWorkspaceSetupOnly: true })
    ).toBe(false)
    expect(isNewWorkspaceSetupOnlyDefault({ defaultTuiAgent: 'blank' })).toBe(false)
    expect(isNewWorkspaceSetupOnlyDefault(null)).toBe(false)
  })
})
