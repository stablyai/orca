import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { activateBrowserPagePaletteResult } from '@/lib/browser/palette/browser-page-palette-activation'
import { activateSimulatorTabPaletteResult } from '@/lib/simulator/tabs/simulator-tab-palette-activation'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace/search/tabs/workspace-tab-palette-activation'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace/tabs/workspace-tab-commands'
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest
} from '@/components/browser-pane/host-guest/input/browser-focus'
import type { OpenTabPaletteItem } from '@/components/worktree-jump/worktree-jump-palette-model'

function workspaceMissing(): void {
  toast.error(
    translate('auto.components.WorktreeJumpPalette.2c38630a01', 'Workspace no longer exists')
  )
}

function tabMissing(): void {
  toast.error(
    translate('auto.components.WorktreeJumpPalette.workspaceTabMissing', 'Tab no longer exists')
  )
}

/** Same activation paths as Cmd+J's Open Tabs rows; true once the tab is in front. */
export function activateTabSearchItem(item: OpenTabPaletteItem): boolean {
  if (item.type === 'browser-page') {
    const activation = activateBrowserPagePaletteResult(item.result)
    if (activation.status === 'failed') {
      if (activation.reason === 'missing-worktree') {
        workspaceMissing()
      } else {
        tabMissing()
      }
      return false
    }
    if (activation.status === 'blocked') {
      return false
    }
    const detail = { pageId: activation.pageId, target: activation.focusTarget }
    queueBrowserFocusRequest(detail)
    window.dispatchEvent(new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, { detail }))
    return true
  }
  const activation =
    item.type === 'simulator-tab'
      ? activateSimulatorTabPaletteResult(item.result)
      : activateWorkspaceTabPaletteResult(item.result)
  if (activation.status === 'failed') {
    if (activation.reason === 'missing-worktree') {
      workspaceMissing()
    } else {
      tabMissing()
    }
    return false
  }
  return activation.status === 'activated'
}

/** Closes like the tab strip's close button, including pinned, unsaved and running-process prompts. */
export function closeTabSearchItem(item: OpenTabPaletteItem): void {
  if (item.type === 'browser-page') {
    // A page row closes its browser tab, as Close Tab does with the page focused.
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'browser-source', sourceId: item.result.pageId }
    })
    return
  }
  dispatchWorkspaceTabCommand({
    type: 'close',
    target: { kind: 'tab', worktreeId: item.result.worktreeId, tabId: item.result.tabId }
  })
}
