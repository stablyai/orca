// Simulator tab opens in a layout-owner build: the window sends the open under a proposed tab id
// (the emulator pane attaches by it); main's frame draws the tab, and only then is it surfaced.

import { createBrowserUuid } from './browser-uuid'
import { openContentTabThroughLayoutOwner } from '@/runtime/layout-owner-content-tab-open'
import { afterPendingTab, isPendingTab } from '@/runtime/layout-owner-pending-tabs'
import type { AppState } from '@/store/types'
import { isFrameDrawnServerWorkspace } from '@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces'
import { runtimeEnvironmentIdUnlessTwin } from './resolve-owner'
import { noteDesktopCreatedServerTab } from './desktop-created-server-tabs'

export type SimulatorTabOpen = {
  worktreeId: string
  label: string
  /** The group the tab joins, or the group a new right split goes beside. */
  groupId: string
  rightSplit: boolean
  /** Runs once main's frame drew the tab. */
  surface: (tabId: string) => void
  /** Today's draw under the proposed id, for a twin main may route to a paired server. */
  drawHere: (tabId: string) => string | null
}

/** A worktree's simulator tab main is still opening: one emulator tab per worktree. */
const opening = new Map<string, string>()

export function openingSimulatorTabId(worktreeId: string): string | undefined {
  const tabId = opening.get(worktreeId)
  return tabId && isPendingTab(tabId) ? tabId : undefined
}

/** The proposed tab id, or null when main is not asked and the caller draws as today. */
export function openSimulatorTabThroughLayoutOwner(
  state: AppState,
  open: SimulatorTabOpen
): string | null {
  const tabId = createBrowserUuid()
  const placement = open.rightSplit
    ? {
        groupId: createBrowserUuid(),
        split: { besideGroupId: open.groupId, direction: 'right' as const }
      }
    : { groupId: open.groupId }
  const sent = openContentTabThroughLayoutOwner(state, {
    worktreeId: open.worktreeId,
    entityId: tabId,
    command: { type: 'openSimulatorTab', tabId, ...placement },
    facts: { label: open.label },
    shown: open.surface,
    drawHere: () => open.drawHere(tabId)
  })
  if (!sent) {
    return null
  }
  opening.set(open.worktreeId, tabId)
  afterPendingTab(tabId, () => {
    if (opening.get(open.worktreeId) === tabId) {
      opening.delete(open.worktreeId)
    }
  })
  return tabId
}

/** The paired server whose frames draw `worktreeId` now: its simulator tab is this desktop's own. */
export function frameDrawnServerOfSimulatorTab(state: AppState, worktreeId: string): string | null {
  const environmentId = runtimeEnvironmentIdUnlessTwin(state, worktreeId)
  return environmentId && isFrameDrawnServerWorkspace(environmentId, worktreeId)
    ? environmentId
    : null
}

/** A simulator tab this desktop drew in that server's workspace: its frames keep it (L273). */
export function noteSimulatorTabCreatedHere(
  environmentId: string,
  worktreeId: string,
  tabId: string
): void {
  // L290 deletes this: post-flip, the host runs the simulator and streams it (#6701).
  noteDesktopCreatedServerTab(environmentId, worktreeId, tabId)
}
