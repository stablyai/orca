// Routes an omnibox switch row to the matching palette activation and reports
// how the destination should take keyboard focus once the menu closes.

import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
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

export function activateOpenTabSearchResult(result: OpenTabSearchResult): OpenTabSelectionOutcome {
  if (result.source === 'browser') {
    const activation = activateBrowserPagePaletteResult({
      executionHostId: result.executionHostId,
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
        requestBrowserFocus({ pageId: activation.pageId, target: activation.focusTarget })
    }
  }

  if (result.source === 'simulator') {
    const activation = activateSimulatorTabPaletteResult({
      executionHostId: result.executionHostId,
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
    return { status: 'activated', focus: null }
  }

  const activation = activateWorkspaceTabPaletteResult({
    executionHostId: result.executionHostId,
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
