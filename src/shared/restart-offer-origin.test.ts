import { describe, expect, it } from 'vitest'
import { restartOfferOrigin } from './restart-offer-origin'
import type { AutomationWorkspaceProvenance } from './worktree/types'

const ME = 'device-me'
const AUTOMATION: AutomationWorkspaceProvenance = {
  kind: 'created-by-automation',
  automationId: 'automation-1',
  automationNameSnapshot: 'Nightly dependency bump',
  automationRunId: 'run-1',
  automationRunTitleSnapshot: 'Nightly',
  createdAt: 1,
  executionTargetType: 'local',
  executionTargetId: 'local',
  projectId: 'project-1'
}

describe('whose interrupted chat this is', () => {
  it('for a paired desktop, follows the sidebar: its own device, the server, or another device', () => {
    const mine = { creatorProvenance: { kind: 'paired-device' as const, deviceId: ME } }
    expect(restartOfferOrigin(mine, ME)).toBe('own')
    expect(
      restartOfferOrigin({ creatorProvenance: { kind: 'paired-device', deviceId: 'other' } }, ME)
    ).toBe('other-device')
    expect(restartOfferOrigin({ creatorProvenance: { kind: 'host' } }, ME)).toBe('server-made')
  })

  // The sidebar shows a workspace with no creator record (a repo's main checkout, one made before
  // Orca recorded creators) as the user's; its interrupted chats are theirs the same way.
  it('for a paired desktop, counts a workspace with no creator record as its own', () => {
    expect(restartOfferOrigin(undefined, ME)).toBe('own')
    expect(restartOfferOrigin({}, ME)).toBe('own')
  })

  it('calls an automation’s workspace an automation’s, for any viewer', () => {
    const robot = {
      creatorProvenance: { kind: 'paired-device' as const, deviceId: ME },
      automationProvenance: AUTOMATION
    }
    expect(restartOfferOrigin(robot, ME)).toBe('automation')
    expect(restartOfferOrigin(robot, null)).toBe('automation')
  })

  it('for the host’s own user, is theirs unless a paired device made the workspace', () => {
    expect(restartOfferOrigin(undefined, null)).toBe('own')
    expect(restartOfferOrigin({ creatorProvenance: { kind: 'host' } }, null)).toBe('own')
    expect(
      restartOfferOrigin({ creatorProvenance: { kind: 'paired-device', deviceId: 'phone' } }, null)
    ).toBe('other-device')
  })
})
