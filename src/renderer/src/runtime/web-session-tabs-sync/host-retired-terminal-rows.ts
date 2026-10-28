import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { terminalLayoutLeafIds } from '../web-session-terminal-orphan-recovery-surface-index'
import { isMirroredTerminalSurfaceId } from './terminal-surfaces'

type RetiredSurface = NonNullable<RuntimeMobileSessionTabsResult['retiredTerminalSurfaces']>[number]

export type HostRetiredTerminals = {
  ptyIds: ReadonlySet<string>
  surfaces: readonly RetiredSurface[]
}

/** The frame's close records, minus any whose handle the host publishes again (handles survive a PTY's re-incarnation). */
export function collectHostRetiredTerminals(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): HostRetiredTerminals | null {
  if (!snapshot.retiredTerminalSurfaces?.length) {
    return null
  }
  const liveHandles = new Set(
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'terminal' && typeof tab.terminal === 'string' ? [tab.terminal] : []
    )
  )
  const surfaces = snapshot.retiredTerminalSurfaces.filter(
    (surface) => !liveHandles.has(surface.terminal)
  )
  if (surfaces.length === 0) {
    return null
  }
  return {
    ptyIds: new Set(
      surfaces.map((surface) => toRemoteRuntimePtyId(surface.terminal, environmentId))
    ),
    surfaces
  }
}

/** A row the mirror keeps is the host's to retire once its close records cover every pane the row holds (#11800). */
export function isTerminalRowRetiredByHost(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined,
  retired: HostRetiredTerminals | null
): boolean {
  if (!retired || isMirroredTerminalSurfaceId(tab.id)) {
    return false
  }
  // A bound pane is identified by its PTY; an unbound one only by the host's tab and leaf ids.
  const isRetired = (leafId: string | null, ptyId: string | null | undefined): boolean =>
    ptyId
      ? retired.ptyIds.has(ptyId)
      : retired.surfaces.some(
          (surface) =>
            surface.parentTabId === tab.id && (leafId === null || surface.leafId === leafId)
        )
  const leaves = terminalLayoutLeafIds(layout)
  if (leaves.length === 0) {
    return isRetired(null, tab.ptyId)
  }
  return leaves.every(({ leafId }) => isRetired(leafId, layout?.ptyIdsByLeafId?.[leafId]))
}
