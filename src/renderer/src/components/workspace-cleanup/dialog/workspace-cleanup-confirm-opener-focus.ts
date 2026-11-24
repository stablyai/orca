import type { WorkspaceCleanupGroup } from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import {
  getWorkspaceCleanupGroupTabId,
  WORKSPACE_CLEANUP_GROUP_PANEL_ID
} from './workspace-cleanup-group-cards'

export type WorkspaceCleanupConfirmOpener =
  | { kind: 'row' | 'retry'; identity: string }
  | { kind: 'bulk' }

function findOpener(opener: WorkspaceCleanupConfirmOpener): HTMLElement | null {
  if (opener.kind === 'bulk') {
    return document.querySelector<HTMLElement>('[data-workspace-cleanup-bulk-delete]')
  }
  const attribute =
    opener.kind === 'row' ? 'data-workspace-cleanup-remove' : 'data-workspace-cleanup-retry'
  for (const element of document.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (element.getAttribute(attribute) === opener.identity) {
      return element
    }
  }
  return null
}

export function findWorkspaceCleanupFocusFallback(scope: ParentNode): HTMLElement | null {
  return scope.querySelector<HTMLElement>(
    `[aria-controls="${WORKSPACE_CLEANUP_GROUP_PANEL_ID}"][aria-selected="true"], [data-workspace-cleanup-run-action]`
  )
}

/**
 * Back remounts the list, so focus returns to the control that opened confirmation once it
 * renders again. A disabled or scrolled-away opener falls back to the active group tab.
 */
export function focusWorkspaceCleanupConfirmOpener(
  opener: WorkspaceCleanupConfirmOpener | null,
  group: WorkspaceCleanupGroup
): void {
  requestAnimationFrame(() => {
    const element = opener ? findOpener(opener) : null
    if (element && !element.hasAttribute('disabled')) {
      element.focus()
      return
    }
    const fallback =
      document.getElementById(getWorkspaceCleanupGroupTabId(group)) ??
      findWorkspaceCleanupFocusFallback(document)
    fallback?.focus()
  })
}
