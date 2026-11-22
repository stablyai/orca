import { structuredLaunchSlotSignatures } from '../../agent-session/launch/structured-agent-session-launch-persistence'

/** `saveSlots`: read during the save in progress, so a keyed attempt and its whole fallback share
 *  one read. `slots`: what the last unified build read. */
type SaveLaunchSlots = {
  saveSlots: ReadonlyMap<string, string> | null
  slots: ReadonlyMap<string, string> | null
}

/** Each worktree's launch slots, read at most once per save when a holder is given. */
export function launchSlotsForSave(holder?: SaveLaunchSlots): ReadonlyMap<string, string> {
  if (!holder) {
    return structuredLaunchSlotSignatures()
  }
  holder.saveSlots ??= structuredLaunchSlotSignatures()
  return holder.saveSlots
}

/** The launch slots a unified build uses, recorded as the ones it read. */
export function launchSlotsForUnifiedBuild(holder?: SaveLaunchSlots): ReadonlyMap<string, string> {
  const slots = launchSlotsForSave(holder)
  if (holder) {
    holder.slots = slots
  }
  return slots
}

/** The save's payload is built: the next save reads launch slots again. */
export function endUnifiedTabSave(holder: SaveLaunchSlots): void {
  holder.saveSlots = null
}

export function sameLaunchSlots(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>
): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [worktreeId, slots] of a) {
    if (b.get(worktreeId) !== slots) {
      return false
    }
  }
  return true
}
