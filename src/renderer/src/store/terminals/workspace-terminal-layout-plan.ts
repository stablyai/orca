import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { releaseTerminalLayoutPtyIds } from './terminal-session-row-hydration'
import { normalizeTerminalLayoutSnapshot } from '../../components/terminal-pane/layout/terminal-layout-normalization'
import { resolvePtyBoundActiveLeafId } from '../../components/terminal-pane/layout/ownership/terminal-layout-active-leaf'
import { resolveTerminalLayoutPtyOwnershipTransfers } from '../../../../shared/workspace-layout/terminal-layout-pty-ownership'
import { sanitizeTerminalLayoutPaneTitles } from '../../../../shared/workspace-layout/terminal-pane-title-sanitization'
import type { TerminalLayoutPtyOwnershipTransfer } from './workspace-terminal-hydration-patch'
import { resolveRootlessTerminalLayoutLeafId } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { mintStablePaneId } from '@/lib/pane-manager/pane-layout/mint-stable-pane-id'
import { singlePaneLayoutSnapshot } from './terminal-single-pane-layout'

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
  const layouts: Record<string, TerminalLayoutSnapshot> = Object.fromEntries(
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
  // Name the ordinary initial pane during hydration, before its automatic-start cohort is captured.
  for (const [tabId, tab] of tabById) {
    const layout = layouts[tabId]
    if (layout?.root) {
      continue
    }
    const leafId =
      resolveRootlessTerminalLayoutLeafId(layout ?? { activeLeafId: null }) ?? mintStablePaneId()
    layouts[tabId] = {
      ...singlePaneLayoutSnapshot(leafId, tab.ptyId ?? undefined),
      ...layout,
      root: { type: 'leaf', leafId },
      activeLeafId: leafId
    }
  }
  return layouts
}
