import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { releaseTerminalLayoutPtyIds } from '../slices/terminal-session-row-hydration'
import {
  normalizeTerminalLayoutSnapshot,
  resolvePtyBoundActiveLeafId
} from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { resolveTerminalLayoutPtyOwnershipTransfers } from '@/components/terminal-pane/terminal-layout-pty-ownership'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import type { TerminalLayoutPtyOwnershipTransfer } from './workspace-terminal-hydration-patch'
import {
  readCanonicalTerminalTabIds,
  resolveDuplicateTerminalLayoutBindings
} from './workspace-terminal-layout-duplicate-bindings'

export type WorkspaceTerminalLayoutPlan = {
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>
  /**
   * Every PTY a row may no longer reattach: the ones the row plan released to a canonical
   * twin, plus the ones a duplicate binding just cost it. Reconnect reads both, so a losing
   * row cannot take its PTY back through `tab.ptyId`.
   */
  releasedPtyIdsByTabId: ReadonlyMap<string, ReadonlySet<string>>
}

export function buildWorkspaceTerminalLayoutPlan({
  ownershipTransfersByTabId,
  ownershipTransferTabIds,
  releasedPtyIdsByTabId,
  session,
  tabById,
  validTabIds
}: {
  ownershipTransfersByTabId: Map<string, TerminalLayoutPtyOwnershipTransfer[]>
  ownershipTransferTabIds: ReadonlySet<string> | null
  releasedPtyIdsByTabId: ReadonlyMap<string, ReadonlySet<string>>
  session: WorkspaceSessionState
  tabById: ReadonlyMap<string, TerminalTab>
  validTabIds: ReadonlySet<string>
}): WorkspaceTerminalLayoutPlan {
  const perTabLayouts = Object.fromEntries(
    Object.entries(session.terminalLayoutsByTabId)
      .filter(([tabId]) => validTabIds.has(tabId))
      .map(([tabId, persisted]) => {
        const releasedPtyIds = releasedPtyIdsByTabId.get(tabId)
        const layout = releasedPtyIds
          ? releaseTerminalLayoutPtyIds(persisted, releasedPtyIds)
          : persisted
        const normalization = normalizeTerminalLayoutSnapshot(layout)
        const normalized = normalization.snapshot
        if (
          normalization.changed &&
          (!ownershipTransferTabIds || ownershipTransferTabIds.has(tabId))
        ) {
          ownershipTransfersByTabId.set(
            tabId,
            resolveTerminalLayoutPtyOwnershipTransfers(layout, normalized)
          )
        }
        const tab = tabById.get(tabId)
        const sanitized = tab ? sanitizeTerminalLayoutPaneTitles(normalized, tab) : normalized
        const activeLeafId = sanitized.root
          ? resolvePtyBoundActiveLeafId({
              root: sanitized.root,
              activeLeafId: sanitized.activeLeafId,
              ptyIdsByLeafId: sanitized.ptyIdsByLeafId
            })
          : sanitized.activeLeafId
        return [tabId, { ...sanitized, activeLeafId }]
      })
  )
  // Why after per-tab normalization: a duplicated leaf or PTY id is only visible across tabs.
  const resolved = resolveDuplicateTerminalLayoutBindings({
    canonicalTabIds: readCanonicalTerminalTabIds(session),
    layoutsByTabId: perTabLayouts,
    tabById
  })
  return {
    layoutsByTabId: resolved.layoutsByTabId,
    releasedPtyIdsByTabId: mergeReleasedPtyIds(
      releasedPtyIdsByTabId,
      resolved.surrenderedPtyIdsByTabId
    )
  }
}

function mergeReleasedPtyIds(
  released: ReadonlyMap<string, ReadonlySet<string>>,
  surrendered: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<string, ReadonlySet<string>> {
  if (surrendered.size === 0) {
    return released
  }
  const merged = new Map<string, ReadonlySet<string>>(released)
  for (const [tabId, ptyIds] of surrendered) {
    merged.set(tabId, new Set([...(released.get(tabId) ?? []), ...ptyIds]))
  }
  return merged
}
