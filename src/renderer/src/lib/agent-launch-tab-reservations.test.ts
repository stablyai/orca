import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_TAB_RESERVATION_TTL_MS,
  agentLaunchReservedGroupIds,
  agentLaunchTabReservationCountForTests,
  reserveAgentLaunchTab,
  claimAgentLaunchTabReservation
} from './agent-launch-tab-reservations'

const PLACEMENT = { worktreeId: 'wt-1', groupId: 'group-2' }

/** What the reveal does: claim the placement, then consume it once the tab exists. */
function reveal(tabId: string, worktreeId: string, now: number) {
  const claim = claimAgentLaunchTabReservation(tabId, worktreeId, now)
  claim?.consume()
  return claim?.reservation ?? null
}
const releases: (() => void)[] = []

function reserve(tabId: string, now = 0, placement = PLACEMENT): () => void {
  const release = reserveAgentLaunchTab(tabId, placement, now)
  releases.push(release)
  return release
}

afterEach(() => {
  releases.splice(0).forEach((release) => release())
})

describe('a launch tab reservation', () => {
  it('hands its placement to the reveal of that tab, once', () => {
    reserve('tab-1')

    expect(reveal('tab-1', 'wt-1', 1)).toEqual(PLACEMENT)
    // Consumed: a second reveal of the same id is not this launch's.
    expect(reveal('tab-1', 'wt-1', 2)).toBeNull()
  })

  it('is not handed to a reveal in another workspace', () => {
    reserve('tab-1')

    expect(reveal('tab-1', 'wt-other', 1)).toBeNull()
  })

  it('dies when the caller releases it after its launch settled', () => {
    const release = reserve('tab-1')

    release()

    expect(reveal('tab-1', 'wt-1', 1)).toBeNull()
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it('lets a release after the reveal took it do nothing', () => {
    const release = reserve('tab-1')
    reveal('tab-1', 'wt-1', 1)

    expect(() => release()).not.toThrow()
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it('does not let a stale release delete a newer reservation under the same id', () => {
    const staleRelease = reserve('tab-1', 0)
    reveal('tab-1', 'wt-1', 1)
    reserve('tab-1', 2, { ...PLACEMENT, groupId: 'group-9' })

    staleRelease()

    expect(reveal('tab-1', 'wt-1', 3)?.groupId).toBe('group-9')
  })

  it('expires when nobody consumed or released it', () => {
    reserve('tab-1', 0)

    expect(reveal('tab-1', 'wt-1', AGENT_LAUNCH_TAB_RESERVATION_TTL_MS)).toBeNull()
  })

  it('sweeps expired entries whenever another launch reserves', () => {
    reserve('tab-1', 0)
    reserve('tab-2', AGENT_LAUNCH_TAB_RESERVATION_TTL_MS)

    expect(agentLaunchTabReservationCountForTests()).toBe(1)
  })

  it('is one placement under every id the tab may arrive as, and dies as one', () => {
    releases.push(reserveAgentLaunchTab(['tab-1', 'agent-session:chat-1'], PLACEMENT, 0))

    expect(agentLaunchTabReservationCountForTests()).toBe(1)
    expect(reveal('agent-session:chat-1', 'wt-1', 1)).toEqual(PLACEMENT)
    // The launch arrived as a chat, so its terminal id holds nothing now.
    expect(reveal('tab-1', 'wt-1', 2)).toBeNull()
    expect(agentLaunchReservedGroupIds('wt-1', 3)).toEqual(new Set())
  })

  it('keeps protecting its group from a claim until the reveal consumes it', () => {
    reserve('tab-1')
    const claim = claimAgentLaunchTabReservation('tab-1', 'wt-1', 1)

    // The reveal activates the workspace between claim and consume, which reconciles tab groups.
    expect(agentLaunchReservedGroupIds('wt-1', 2)).toEqual(new Set(['group-2']))
    claim?.consume()
    expect(agentLaunchReservedGroupIds('wt-1', 3)).toEqual(new Set())
  })
})
