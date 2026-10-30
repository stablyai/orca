import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'

// Hold local renames over pre-rename snapshots until host echo/new revision/expiry; unique leaf IDs key the hold.
export const PENDING_PANE_TITLE_HOLD_MS = 15_000

type PendingRename = {
  title: string | null
  /** The host's title before these renames, then each earlier rename still in flight; any other host value is a newer revision. */
  older: (string | null)[]
  notedAt: number
  /** Not yet sent to the host as an explicit rename. */
  unsent: boolean
}

const pendingByLeafId = new Map<string, PendingRename>()

// Why: a closed tab or a lost host never answers; expired holds go on any later call.
function pruneExpiredPaneTitleRenames(now: number): void {
  for (const [leafId, pending] of pendingByLeafId) {
    if (now - pending.notedAt >= PENDING_PANE_TITLE_HOLD_MS) {
      pendingByLeafId.delete(leafId)
    }
  }
}

/** Records a user's rename of a host-owned pane; a window's own tabs need no hold. */
export function notePendingPaneTitleRename(args: {
  leafId: string
  title: string | null
  layout: TerminalLayoutSnapshot | undefined
  now?: number
}): void {
  const ptyIds = Object.values(args.layout?.ptyIdsByLeafId ?? {})
  if (!ptyIds.some((ptyId) => isRemoteRuntimePtyId(ptyId))) {
    return
  }
  const now = args.now ?? Date.now()
  pruneExpiredPaneTitleRenames(now)
  // A rename on top of an unconfirmed one still waits on the host's original name.
  const earlier = pendingByLeafId.get(args.leafId)
  pendingByLeafId.set(args.leafId, {
    title: args.title,
    older: earlier
      ? [...earlier.older, earlier.title]
      : [args.layout?.titlesByLeafId?.[args.leafId]?.trim() || null],
    notedAt: now,
    unsent: true
  })
}

/** The renamed panes a layout push should name explicitly, each sent once. */
export function takeUnsentPaneTitleRenames(leafIds: readonly string[]): string[] {
  return leafIds.filter((leafId) => {
    const pending = pendingByLeafId.get(leafId)
    if (!pending?.unsent) {
      return false
    }
    pending.unsent = false
    return true
  })
}

/** A push that failed carried nothing; the next push names these panes again, within the hold. */
export function requeuePendingPaneTitleRenames(leafIds: readonly string[]): void {
  for (const leafId of leafIds) {
    const pending = pendingByLeafId.get(leafId)
    if (pending) {
      pending.unsent = true
    }
  }
}

/** The host's pane titles with each still-held local rename kept over them. */
export function withPendingPaneTitleRenames(
  hostTitles: Record<string, string> | undefined,
  leafIds: readonly string[],
  now: number = Date.now()
): Record<string, string> | undefined {
  pruneExpiredPaneTitleRenames(now)
  const titles = { ...hostTitles }
  for (const leafId of leafIds) {
    const pending = pendingByLeafId.get(leafId)
    if (!pending) {
      continue
    }
    const hostTitle = titles[leafId]?.trim() || null
    // Echoed or superseded by a newer host revision: the host's name stands.
    if (hostTitle === pending.title || !pending.older.includes(hostTitle)) {
      pendingByLeafId.delete(leafId)
      continue
    }
    if (pending.title === null) {
      delete titles[leafId]
    } else {
      titles[leafId] = pending.title
    }
  }
  return Object.keys(titles).length > 0 ? titles : undefined
}
