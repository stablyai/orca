// Routes an omnibox switch row to the matching palette activation and reports
// how the destination should take keyboard focus once the menu closes.

import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest,
  type BrowserFocusRequestDetail
} from '@/components/browser-pane/browser-focus'
import { translate } from '@/i18n/i18n'
import { activateBrowserPagePaletteResult } from '@/lib/browser-page-palette-activation'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { activateSimulatorTabPaletteResult } from '@/lib/simulator-tab-palette-activation'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace-tab-palette-activation'
import type { OpenTabSearchResult } from './open-tab-search'

export type OpenTabSelectionOutcome =
  | { status: 'activated'; focus: (() => void) | null }
  | { status: 'failed'; message: string }

// Every source distinguishes a dead workspace from a target that went stale
// inside a live one; only the stale wording differs.
function failed(reason: string, staleMessage: string): OpenTabSelectionOutcome {
  return {
    status: 'failed',
    message:
      reason === 'missing-worktree'
        ? translate(
            'auto.components.tab.bar.TabBarCreateEntry.2c38630a01',
            'Workspace no longer exists'
          )
        : staleMessage
  }
}

function requestBrowserPageFocus(detail: BrowserFocusRequestDetail): void {
  queueBrowserFocusRequest(detail)
  window.dispatchEvent(new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, { detail }))
}

export function activateOpenTabSearchResult(result: OpenTabSearchResult): OpenTabSelectionOutcome {
  if (result.source === 'browser') {
    const activation = activateBrowserPagePaletteResult({
      pageId: result.pageId,
      workspaceId: result.workspaceId,
      worktreeId: result.worktreeId
    })
    if (activation.status === 'failed') {
      return failed(
        activation.reason,
        translate(
          'auto.components.tab.bar.TabBarCreateEntry.d7d496a451',
          'Browser page no longer exists'
        )
      )
    }
    return {
      status: 'activated',
      focus: () =>
        requestBrowserPageFocus({ pageId: activation.pageId, target: activation.focusTarget })
    }
  }

  if (result.source === 'simulator') {
    const activation = activateSimulatorTabPaletteResult({
      tabId: result.tabId,
      worktreeId: result.worktreeId
    })
    if (activation.status === 'failed') {
      return failed(
        activation.reason,
        translate(
          'auto.components.tab.bar.TabBarCreateEntry.7726ce9970',
          'Mobile emulator tab no longer exists'
        )
      )
    }
    return { status: 'activated', focus: () => focusTerminalTabSurface(activation.tabId) }
  }

  const activation = activateWorkspaceTabPaletteResult({
    contentType: result.contentType,
    entityId: result.entityId,
    groupId: result.groupId,
    tabId: result.tabId,
    worktreeId: result.worktreeId
  })
  if (activation.status === 'failed') {
    return failed(
      activation.reason,
      translate('auto.components.tab.bar.TabBarCreateEntry.4f0d9a71c2', 'Tab no longer exists')
    )
  }
  // Editors focus themselves when they mount; only the terminal surface needs a handoff.
  return {
    status: 'activated',
    focus: result.contentType === 'terminal' ? () => focusTerminalTabSurface(result.entityId) : null
  }
}
