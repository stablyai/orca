import { describe, expect, it, vi } from 'vitest'
import { getWorkspaceLastActiveAt, withCleanupVisitEvidence } from './workspace-last-active'
import { makeCleanupCandidate as candidate } from './workspace-last-active.test-fixture'

vi.mock('./sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 100 * DAY_MS

describe('workspace last active with the switch on', () => {
  it('takes the later of the Recent stamp and the last visit', () => {
    expect(getWorkspaceLastActiveAt(5, 9)).toBe(9)
    expect(getWorkspaceLastActiveAt(9, 5)).toBe(9)
    expect(getWorkspaceLastActiveAt(5, undefined)).toBe(5)
    expect(getWorkspaceLastActiveAt(5, Number.NaN)).toBe(5)
    expect(getWorkspaceLastActiveAt(Number.NaN, 9)).toBe(9)
  })

  it('a newer visit only drops the idle reasons it disproves', () => {
    const archived = candidate({
      lastActivityAt: NOW - 40 * DAY_MS,
      reasons: ['archived', 'idle-clean']
    })
    // Ten days ago: still archived-idle (7 d), no longer idle-clean (30 d).
    expect(withCleanupVisitEvidence(archived, NOW - 10 * DAY_MS, NOW)).toMatchObject({
      lastActivityAt: NOW - 10 * DAY_MS,
      reasons: ['archived']
    })
    // An older visit changes nothing.
    expect(withCleanupVisitEvidence(archived, NOW - 50 * DAY_MS, NOW)).toBe(archived)
  })
})
