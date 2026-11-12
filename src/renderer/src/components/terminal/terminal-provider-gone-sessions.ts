import { publishTerminalProviderCapabilityChange } from './terminal-provider-capability-revision'

const goneSessionPtyIds = new Set<string>()
// A bound PTY is live under its id, so a late gone answer for it is stale.
const boundSessionPtyIds = new Set<string>()
let goneProbeGeneration = 0

/** Startup only: restored ids the provider says no longer exist. Never awaited before reconnect; unknown ids keep today's mounted path. */
export async function probeTerminalProviderGoneSessions(
  ptyIds: readonly string[],
  resolveGone: ((ids: string[]) => Promise<string[]>) | undefined = window.api.pty.getGoneSessionIds
): Promise<void> {
  const generation = goneProbeGeneration
  const candidates = ptyIds.filter((id) => id.length > 0 && !boundSessionPtyIds.has(id))
  if (!resolveGone || candidates.length === 0) {
    return
  }
  const sizeBefore = goneSessionPtyIds.size
  const changedPtyIds = new Set<string>()
  for (let offset = 0; offset < candidates.length; offset += 512) {
    const gone = await resolveGone(candidates.slice(offset, offset + 512)).catch(() => [])
    if (generation !== goneProbeGeneration) {
      return
    }
    for (const id of gone.filter((goneId) => !boundSessionPtyIds.has(goneId))) {
      if (!goneSessionPtyIds.has(id)) {
        changedPtyIds.add(id)
      }
      goneSessionPtyIds.add(id)
    }
  }
  if (goneSessionPtyIds.size !== sizeBefore) {
    publishTerminalProviderCapabilityChange(changedPtyIds)
  }
}

/** Spawn or attach proves the session lives under this id, so a pane revived after a gone answer gets ordinary watchers again. */
export function markTerminalProviderSessionBound(ptyId: string): void {
  boundSessionPtyIds.add(ptyId)
  if (goneSessionPtyIds.delete(ptyId)) {
    publishTerminalProviderCapabilityChange([ptyId])
  }
}

/** The provider answered that this restored session no longer exists, so a pane remount respawns it and nothing is lost by parking. */
export function terminalProviderSessionIsGone(ptyId: string): boolean {
  return goneSessionPtyIds.has(ptyId)
}

export function pruneTerminalProviderGoneSessions(live: ReadonlySet<string>): void {
  for (const ids of [goneSessionPtyIds, boundSessionPtyIds]) {
    for (const id of ids) {
      if (!live.has(id)) {
        ids.delete(id)
      }
    }
  }
}

/** Returns whether any gone answer was dropped, so the caller can publish one change. */
export function clearTerminalProviderGoneSessions(): boolean {
  const hadGone = goneSessionPtyIds.size > 0
  goneSessionPtyIds.clear()
  boundSessionPtyIds.clear()
  goneProbeGeneration += 1
  return hadGone
}
