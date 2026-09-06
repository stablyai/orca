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
}): Record<string, TerminalLayoutSnapshot> {
  return Object.fromEntries(
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
}
