import type { WorkspaceCleanupGroup } from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { getWorkspaceCleanupGroupTabId } from './workspace-cleanup-group-cards'

/** What opened confirmation: one row's Remove, or the footer's bulk Delete. */
export type WorkspaceCleanupConfirmOpener = { kind: 'row'; identity: string } | { kind: 'bulk' }

function findOpener(opener: WorkspaceCleanupConfirmOpener): HTMLElement | null {
  if (opener.kind === 'bulk') {
    return document.querySelector<HTMLElement>('[data-workspace-cleanup-bulk-delete]')
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-workspace-cleanup-remove]')) {
    if (element.dataset.workspaceCleanupRemove === opener.identity) {
      return element
    }
  }
  return null
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
    document.getElementById(getWorkspaceCleanupGroupTabId(group))?.focus()
  })
}
