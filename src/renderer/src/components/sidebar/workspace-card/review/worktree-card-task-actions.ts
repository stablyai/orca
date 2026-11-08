import type { MouseEvent } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Row-menu actions for the card's own issue or task; each one dismisses the hovercard. */
export type WorktreeCardTaskActionHandlers = {
  onCopyLink: (url: string) => void
  onEditIssue?: (event: MouseEvent) => void
  onOpenGitHubIssueInOrca?: (event: MouseEvent) => void
  onOpenIssueInBrowser?: (url: string) => void
  onOpenLinearIssueInOrca?: (event: MouseEvent) => void
}

async function copyWorkItemLink(url: string): Promise<void> {
  try {
    // Electron clipboard IPC survives nested overlays that can lose browser activation.
    await window.api.ui.writeClipboardText(url)
    toast.success(
      translate('auto.components.sidebar.WorktreeCardMeta.copyLinkSuccess', '{{value0}} copied', {
        value0: translate('auto.components.sidebar.WorktreeCardMeta.issueLinkLabel', 'Issue link')
      })
    )
  } catch {
    toast.error(
      translate('auto.components.sidebar.WorktreeCardMeta.copyLinkFailure', 'Failed to copy link')
    )
  }
}

function dismissing<T>(
  closeHover: () => void,
  run: ((arg: T) => void) | undefined
): ((arg: T) => void) | undefined {
  return run
    ? (arg) => {
        closeHover()
        run(arg)
      }
    : undefined
}

export function getWorktreeCardTaskActions(
  closeHover: () => void,
  handlers: Omit<WorktreeCardTaskActionHandlers, 'onCopyLink'>
): WorktreeCardTaskActionHandlers {
  return {
    onCopyLink: (url) => {
      closeHover()
      void copyWorkItemLink(url)
    },
    // Why: editing opens a dialog that owns its own dismissal of the card.
    onEditIssue: handlers.onEditIssue,
    onOpenGitHubIssueInOrca: dismissing(closeHover, handlers.onOpenGitHubIssueInOrca),
    onOpenIssueInBrowser: dismissing(closeHover, handlers.onOpenIssueInBrowser),
    onOpenLinearIssueInOrca: dismissing(closeHover, handlers.onOpenLinearIssueInOrca)
  }
}
