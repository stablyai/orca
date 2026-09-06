import { describe, expect, it } from 'vitest'
import { shouldShowLocalWorkspacePortSections } from './local-workspace-port-sections'

const empty = { activePorts: [], otherWorkspacePorts: [], externalPorts: [] }

describe('shouldShowLocalWorkspacePortSections', () => {
  it('shows the sections whenever the scan succeeded', () => {
    expect(shouldShowLocalWorkspacePortSections(null, empty)).toBe(true)
    expect(shouldShowLocalWorkspacePortSections({}, empty)).toBe(true)
  })

  // Why: a failed scan keeps the host's last-good ports, and the status bar
  // still counts and lists them — hiding the sections here would strip the
  // stop and open actions for ports the user can still see elsewhere.
  it.each([
    ['activePorts', { ...empty, activePorts: [{}] }],
    ['otherWorkspacePorts', { ...empty, otherWorkspacePorts: [{}] }],
    ['externalPorts', { ...empty, externalPorts: [{}] }]
  ])('keeps the sections when a failed scan retained %s', (_section, sections) => {
    expect(shouldShowLocalWorkspacePortSections({ unavailableReason: 'dropped' }, sections)).toBe(
      true
    )
  })

  it('lets the notice stand alone when a failed scan has nothing left to list', () => {
    expect(shouldShowLocalWorkspacePortSections({ unavailableReason: 'dropped' }, empty)).toBe(
      false
    )
  })
})
