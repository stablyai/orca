// What each bot row last saw of its active line, by the bot's lineage fold key. A row that
// unmounts (section folded, search) and mounts again with nothing changed must not unfold
// a bot the owner folded; a change, seen while mounted or since it last saw, still does.
const observed = new Map<string, string>()

/** Records what the row sees now; true when that differs from what it last saw. */
export function observeBotActiveLine(
  groupKey: string,
  activeLineId: string | null,
  listedOnlyHere: boolean
): boolean {
  const seen = `${listedOnlyHere ? 1 : 0}\n${activeLineId ?? ''}`
  const changed = observed.get(groupKey) !== seen
  observed.set(groupKey, seen)
  return changed
}

/** Forgets bots no longer listed. */
export function pruneBotAutoUnfoldMemory(liveGroupKeys: ReadonlySet<string>): void {
  for (const key of observed.keys()) {
    if (!liveGroupKeys.has(key)) {
      observed.delete(key)
    }
  }
}
