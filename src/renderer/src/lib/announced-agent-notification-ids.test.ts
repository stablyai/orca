import { beforeEach, describe, expect, it } from 'vitest'
import {
  claimAnnouncedAgentNotificationId,
  isAnnouncedAgentNotificationClaimCurrent,
  resetAnnouncedAgentNotificationIdsForTest,
  takeAnnouncedAgentNotificationIds,
  transferAnnouncedAgentNotificationClaim
} from './announced-agent-notification-ids'

describe('announced agent notification ids', () => {
  beforeEach(() => resetAnnouncedAgentNotificationIdsForTest())

  it('reuses one id until the pane is acknowledged', () => {
    const first = claimAnnouncedAgentNotificationId('pane-1', 'worktree-1', 'id-1')
    const second = claimAnnouncedAgentNotificationId('pane-1', 'worktree-1', 'id-2')
    expect(first.notificationId).toBe('id-1')
    expect(second).toEqual(first)
    expect(takeAnnouncedAgentNotificationIds('pane-1')).toEqual(['id-1'])
    expect(isAnnouncedAgentNotificationClaimCurrent(first.claimToken)).toBe(false)
    expect(claimAnnouncedAgentNotificationId('pane-1', 'worktree-1', 'id-2')).toEqual(
      expect.objectContaining({ notificationId: 'id-2' })
    )
  })

  it('replaces a claim when a reused pane key moves worktrees', () => {
    claimAnnouncedAgentNotificationId('pane-1', 'worktree-1', 'id-1')

    expect(claimAnnouncedAgentNotificationId('pane-1', 'worktree-2', 'id-2')).toEqual(
      expect.objectContaining({
        notificationId: 'id-2',
        supersededNotificationId: 'id-1'
      })
    )
    expect(takeAnnouncedAgentNotificationIds('pane-1')).toEqual(['id-2'])
  })

  it('returns an evicted pane id for dismissal instead of orphaning it', () => {
    for (let index = 0; index < 128; index += 1) {
      claimAnnouncedAgentNotificationId(`pane-${index}`, 'worktree-1', `id-${index}`)
    }

    expect(claimAnnouncedAgentNotificationId('pane-128', 'worktree-1', 'id-128')).toEqual(
      expect.objectContaining({
        notificationId: 'id-128',
        supersededNotificationId: 'id-0'
      })
    )
    expect(takeAnnouncedAgentNotificationIds('pane-0')).toEqual([])
  })

  it('moves a claim with pane authority and returns a superseded target id', () => {
    const source = claimAnnouncedAgentNotificationId('pane-1', 'worktree-1', 'id-1')
    claimAnnouncedAgentNotificationId('pane-2', 'worktree-1', 'id-2')

    expect(transferAnnouncedAgentNotificationClaim('pane-1', 'pane-2')).toBe('id-2')
    expect(isAnnouncedAgentNotificationClaimCurrent(source.claimToken)).toBe(true)
    expect(takeAnnouncedAgentNotificationIds('pane-1')).toEqual([])
    expect(takeAnnouncedAgentNotificationIds('pane-2')).toEqual(['id-1'])
  })
})
