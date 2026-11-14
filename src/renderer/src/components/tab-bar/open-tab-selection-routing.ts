// Route switch rows through palette activation and return focus handoff for after the menu closes.

import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { translate } from '@/i18n/i18n'
import {
  activateBrowserPagePaletteResult,
  type BrowserPagePaletteActivationFailure
} from '@/lib/browser/palette/browser-page-palette-activation'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { activateSimulatorTabPaletteResult } from '@/lib/simulator/tabs/simulator-tab-palette-activation'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace/search/tabs/workspace-tab-palette-activation'
import { useAppStore } from '@/store/index'
import type { OpenTabSearchResult } from './open-tab-search'

export type OpenTabSelectionOutcome =
  | { status: 'activated'; focus: (() => void) | null }
  | { status: 'blocked' }
  | { status: 'failed'; message: string }

// Distinguish dead workspaces from stale targets inside live ones across all sources.
function failureMessage(reason: string, staleMessage: string): string {
  return reason === 'missing-worktree'
    ? translate(
        'auto.components.tab.bar.TabBarCreateEntry.2c38630a01',
        'Workspace no longer exists'
      )
    : staleMessage
}

function failed(reason: string, staleMessage: string): OpenTabSelectionOutcome {
  return { status: 'failed', message: failureMessage(reason, staleMessage) }
}

/** Why a browser page could not be shown: a gone workspace, or a gone page or tab. */
export function browserPageActivationFailureMessage(
  reason: BrowserPagePaletteActivationFailure
): string {
  return failureMessage(
    reason,
    translate(
      'auto.components.tab.bar.TabBarCreateEntry.d7d496a451',
      'Browser page no longer exists'
    )
  )
}

export function activateOpenTabSearchResult(result: OpenTabSearchResult): OpenTabSelectionOutcome {
  if (result.source === 'browser') {
    const activation = activateBrowserPagePaletteResult({
      executionHostId: result.executionHostId,
      pageId: result.pageId,
      workspaceId: result.workspaceId,
      worktreeId: result.worktreeId
    })
    if (activation.status === 'blocked') {
      return activation
    }
    if (activation.status === 'failed') {
      return { status: 'failed', message: browserPageActivationFailureMessage(activation.reason) }
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
    if (activation.status === 'blocked') {
      return activation
    }
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
  if (activation.status === 'blocked') {
    return activation
  }
  if (activation.status === 'failed') {
    return failed(
      activation.reason,
      translate('auto.components.tab.bar.TabBarCreateEntry.4f0d9a71c2', 'Tab no longer exists')
    )
  }
  // Editors focus themselves when they mount; only the terminal surface needs a handoff.
  return {
    status: 'activated',
    focus:
      result.contentType === 'terminal'
        ? () =>
            focusTerminalTabSurface(
              result.entityId,
              useAppStore.getState().terminalLayoutsByTabId[result.entityId]?.activeLeafId ?? null
            )
        : null
  }
}
