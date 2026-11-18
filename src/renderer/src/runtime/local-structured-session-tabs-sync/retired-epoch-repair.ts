import { createSessionTabsAuthorityRepairLane } from '../web-session-tabs-sync/tracking/session-tabs-authority-repair'
import {
  isCurrentLocalStructuredSessionGeneration,
  localStructuredSessionEpochHistoryByWorktree,
  localStructuredSessionGeneration
} from './inventory-generation-fence'

/** The local structured-session mirror's lane, keyed by worktree. */
const localRepairLane = createSessionTabsAuthorityRepairLane({
  logLabel: 'structured-session-tabs',
  generation: localStructuredSessionGeneration,
  isCurrent: isCurrentLocalStructuredSessionGeneration,
  isStillRetired: (worktreeId, publicationEpoch) =>
    localStructuredSessionEpochHistoryByWorktree
      .get(worktreeId)
      ?.retired.includes(publicationEpoch) ?? false
})

export const scheduleRetiredEpochRepair = localRepairLane.schedule
export function forgetRetiredEpochRepairsOutside(isKnown: (worktreeId: string) => boolean): void {
  localRepairLane.forget((worktreeId) => !isKnown(worktreeId))
}
export const resetRetiredEpochRepairsForTests = localRepairLane.resetForTests
