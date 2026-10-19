import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { AiVaultSessionTitle } from '../../../../shared/ai-vault-session-title'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import {
  readCanonicalPtyOwners,
  resolveCanonicalPtyClaim,
  type CanonicalPtyOwners
} from '../../../../shared/workspace-layout/legacy-terminal-row-claims'
import { clearTransientTerminalState } from './terminal-helpers'

/**
 * A persisted session describes the same terminals twice: as canonical unified tabs and as
 * legacy per-worktree terminal rows. Hydration keeps every row that still owns a PTY nothing
 * else can reattach to, drops rows the canonical mount fully subsumes, and strips the shared
 * PTYs off rows it only partially subsumes.
 */

type CanonicalTerminals = CanonicalPtyOwners & {
  quickCommandLabelByTabId: Map<string, string>
  aiVaultTitleByTabId: Map<string, AiVaultSessionTitle>
}

export type WorkspaceTerminalRowHydration = {
  rows: TerminalTab[]
  /** PTYs a retained row must give up because a canonical row already owns them. */
  releasedPtyIdsByTabId: Map<string, Set<string>>
  /**
   * The PTY a retained row still owns after the release, so reconnect can anchor on it. Hydration
   * nulls `tab.ptyId`, and orphan detection ignores layout bindings, so a row that gave up its
   * tab-level PTY has no liveness left and the sweep deletes it before its own pane reattaches.
   */
  reconnectPtyIdByRetainedTabId: Map<string, string>
  /** Rows dropped as pure canonical duplicates; they are never retired, so callers clean up after them. */
  subsumedTabIds: string[]
  /** Rows dropped for an unusable tab id; like subsumed rows they need caller-side cleanup. */
  invalidTabIds: string[]
  /** The canonical row that inherited each subsumed row's PTYs, so pointers at it can follow. */
  canonicalTabIdBySubsumedTabId: Map<string, string>
}

export function hydrateWorkspaceTerminalRows(
  session: WorkspaceSessionState,
  worktreeId: string,
  rows: readonly TerminalTab[],
  liveTitleTabIds?: Pick<ReadonlySet<string>, 'has'>
): WorkspaceTerminalRowHydration {
  const canonical = readCanonicalTerminals(session, worktreeId, rows)
  const releasedPtyIdsByTabId = new Map<string, Set<string>>()
  const reconnectPtyIdByRetainedTabId = new Map<string, string>()
  const subsumedTabIds: string[] = []
  const invalidTabIds: string[] = []
  const canonicalTabIdBySubsumedTabId = new Map<string, string>()
  const retained: TerminalTab[] = []
  for (const row of rows) {
    // Why: old web-client mirrors could persist host surface ids with "::"; makePaneKey reserves ":" as its separator.
    if (!isValidTerminalTabId(row.id)) {
      invalidTabIds.push(row.id)
      continue
    }
    const claim = resolveCanonicalPtyClaim(session, row, canonical)
    if (claim.kind === 'subsumed') {
      subsumedTabIds.push(row.id)
      canonicalTabIdBySubsumedTabId.set(row.id, claim.canonicalTabId)
      continue
    }
    if (claim.releasedPtyIds.size > 0) {
      releasedPtyIdsByTabId.set(row.id, claim.releasedPtyIds)
    }
    if (claim.reconnectPtyId) {
      reconnectPtyIdByRetainedTabId.set(row.id, claim.reconnectPtyId)
    }
    retained.push(row)
  }
  return {
    rows: retained
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
      .map((row, index) =>
        restoreCanonicalMetadata(row, index, canonical, liveTitleTabIds?.has(row.id) ?? false)
      ),
    releasedPtyIdsByTabId,
    reconnectPtyIdByRetainedTabId,
    subsumedTabIds,
    invalidTabIds,
    canonicalTabIdBySubsumedTabId
  }
}

/** Drop the PTYs a canonical row owns so the retained row records only its own panes. */
export function releaseTerminalLayoutPtyIds(
  layout: TerminalLayoutSnapshot,
  releasedPtyIds: ReadonlySet<string>
): TerminalLayoutSnapshot {
  const ptyIdsByLeafId = layout.ptyIdsByLeafId
  if (!ptyIdsByLeafId) {
    return layout
  }
  const kept = Object.entries(ptyIdsByLeafId).filter(([, ptyId]) => !releasedPtyIds.has(ptyId))
  if (kept.length === Object.keys(ptyIdsByLeafId).length) {
    return layout
  }
  return { ...layout, ptyIdsByLeafId: Object.fromEntries(kept) }
}

/** Leaves a retained row just lost the PTY for; their panes now cold-start instead of reattaching. */
export function collectReleasedLeafIds(
  layout: TerminalLayoutSnapshot | undefined,
  releasedPtyIds: ReadonlySet<string>
): string[] {
  return Object.entries(layout?.ptyIdsByLeafId ?? {})
    .filter(([, ptyId]) => releasedPtyIds.has(ptyId))
    .map(([leafId]) => leafId)
}

function readCanonicalTerminals(
  session: WorkspaceSessionState,
  worktreeId: string,
  rows: readonly TerminalTab[]
): CanonicalTerminals {
  const canonicalTabs = (session.unifiedTabs?.[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal'
  )
  return {
    ...readCanonicalPtyOwners(session, worktreeId, rows),
    quickCommandLabelByTabId: new Map(
      canonicalTabs.flatMap((tab) =>
        tab.quickCommandLabel?.trim() ? [[tab.entityId, tab.quickCommandLabel.trim()]] : []
      )
    ),
    aiVaultTitleByTabId: new Map(
      canonicalTabs.flatMap((tab) => (tab.aiVaultTitle ? [[tab.entityId, tab.aiVaultTitle]] : []))
    )
  }
}

function restoreCanonicalMetadata(
  row: TerminalTab,
  index: number,
  canonical: CanonicalTerminals,
  titleIsLive: boolean
): TerminalTab {
  const quickCommandLabel =
    row.quickCommandLabel?.trim() || canonical.quickCommandLabelByTabId.get(row.id)
  const aiVaultTitle = row.aiVaultTitle ?? canonical.aiVaultTitleByTabId.get(row.id)
  return {
    ...clearTransientTerminalState(row, index),
    ...(titleIsLive ? { title: row.title } : {}),
    ...(quickCommandLabel ? { quickCommandLabel } : {}),
    ...(aiVaultTitle ? { aiVaultTitle } : {}),
    sortOrder: index,
    // Why: suppress restored mounts so only real activity updates Recent.
    pendingActivationSpawn: true,
    restoredFromSession: true
  }
}
