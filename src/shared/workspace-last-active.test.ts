import { describe, expect, it } from 'vitest'
import { getWorkspaceLastActiveAt, withCleanupVisitEvidence } from './workspace-last-active'
import { makeCleanupCandidate } from './workspace-last-active.test-fixture'

// Switch off (the default build): visits never change what readers call "last active".
describe('workspace last active with the switch off', () => {
  it('reads the Recent stamp alone', () => {
    expect(getWorkspaceLastActiveAt(5, 9)).toBe(5)
  })

  it('returns the cleanup candidate as main built it', () => {
    const candidate = makeCleanupCandidate({ lastActivityAt: 5, reasons: ['idle-clean'] })
    expect(withCleanupVisitEvidence(candidate, 9, 10)).toBe(candidate)
  })
})
