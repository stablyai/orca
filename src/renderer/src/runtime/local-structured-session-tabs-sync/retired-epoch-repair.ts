import { createSessionTabsAuthorityRepairLane } from '../web-session-tabs-sync/session-tabs-authority-repair'
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
export function forgetRetiredEpochRepairsOutside(knownWorktreeIds: ReadonlySet<string>): void {
  localRepairLane.forget((worktreeId) => !knownWorktreeIds.has(worktreeId))
}
export const resetRetiredEpochRepairsForTests = localRepairLane.resetForTests
