import { describe, expect, it } from 'vitest'
import {
  getWorkspaceCardPropertiesValue,
  getShownWorkspaceViewSections,
  type WorkspaceViewOptionContext,
  type WorkspaceViewOptionKey
} from './workspace-view-options'

const LOCAL_ONLY: WorkspaceViewOptionContext = {
  groupBy: 'none',
  hideSleepingWorkspaces: false,
  hideWorkspacesFromOtherDevices: false,
  newCardStyle: false,
  hasRemoteHosts: false,
  projectCount: 1,
  mayHaveServerHosts: false
}

function shownKeys(overrides: Partial<WorkspaceViewOptionContext> = {}): WorkspaceViewOptionKey[] {
  return getShownWorkspaceViewSections({ ...LOCAL_ONLY, ...overrides }).flatMap(({ options }) =>
    options.map((option) => option.key)
  )
}

describe('which Workspace options show', () => {
  it('shows the base controls for a single local project', () => {
    expect(shownKeys()).toEqual([
      'groupBy',
      'sortBy',
      'cardLayout',
      'cardProperties',
      'hideSleepingWorkspaces',
      'hideDefaultBranchWorkspace',
      'hideAutomationGeneratedWorkspaces',
      'hideCliCreatedWorkspaces',
      'hideDetachedHeadWorkspaces'
    ])
  })

  it('shows the Show section for remote hosts and for more than one project', () => {
    expect(shownKeys({ hasRemoteHosts: true }).slice(0, 2)).toEqual(['hosts', 'groupBy'])
    expect(shownKeys({ projectCount: 2 }).slice(0, 2)).toEqual(['projects', 'groupBy'])
  })

  it('shows Project order only while grouping by project', () => {
    expect(shownKeys({ groupBy: 'repo' })).toContain('projectOrderBy')
    expect(shownKeys({ groupBy: 'pr-status' })).not.toContain('projectOrderBy')
  })

  it('shows the default-branch exemption only while sleeping workspaces are hidden', () => {
    expect(shownKeys()).not.toContain('alwaysShowDefaultBranchWorkspace')
    const keys = shownKeys({ hideSleepingWorkspaces: true })
    expect(keys.indexOf('alwaysShowDefaultBranchWorkspace')).toBe(
      keys.indexOf('hideSleepingWorkspaces') + 1
    )
  })

  it('shows the other-client filter when servers may exist, or while it is on', () => {
    expect(shownKeys()).not.toContain('hideWorkspacesFromOtherDevices')
    expect(shownKeys({ mayHaveServerHosts: true })).toContain('hideWorkspacesFromOtherDevices')
    expect(shownKeys({ hideWorkspacesFromOtherDevices: true })).toContain(
      'hideWorkspacesFromOtherDevices'
    )
  })

  it('swaps Card layout and Show properties for Card display in the experimental card style', () => {
    const keys = shownKeys({ newCardStyle: true })
    expect(keys).toContain('cardDisplay')
    expect(keys).not.toContain('cardLayout')
    expect(keys).not.toContain('cardProperties')
  })
})

describe('the Show properties value', () => {
  it('reads Hover under the compact layout, else how many properties show, else nothing', () => {
    expect(getWorkspaceCardPropertiesValue(['pr', 'host'], true)).toBe('hover')
    expect(getWorkspaceCardPropertiesValue(['pr', 'host'], false)).toBe(2)
    // Ids outside the Show properties list (Card display only) are not counted.
    expect(getWorkspaceCardPropertiesValue(['cli', 'branch'], false)).toBeNull()
  })
})
