// In layout-owner builds send browser commands before changing state; main frames draw tab/page/profile fields, then window writes page-local state. Refusal preserves tabs.

import { sendLayoutApply, type WindowLayoutCommand } from '@/runtime/layout-apply-send'
import { beginPendingTab } from '@/runtime/layout-owner-pending-tabs'
import type { BrowserSliceGet } from './browser-slice-contract'

type BrowserLayoutCommand = Extract<
  WindowLayoutCommand,
  { type: 'openBrowserPage' | 'closeBrowserPage' | 'replaceBrowserPage' | 'setBrowserTabProfile' }
>

/** Return false for paired-owned layouts and use here directly. Main may route twins to paired servers; shown runs only after frames arrive. */
export function sendBrowserLayoutCommand(
  get: BrowserSliceGet,
  worktreeId: string,
  command: BrowserLayoutCommand,
  write: { here: () => void; shown?: () => void }
): boolean {
  // A page being added is pending on its tab: a caller acting on the tab's pages waits for it.
  const settle =
    command.type === 'openBrowserPage'
      ? beginPendingTab(command.pageId, worktreeId, command.browserTabId, { kind: 'open' })
      : () => {}
  const sent = sendLayoutApply(get(), worktreeId, command, {
    apply: () => {
      try {
        write.shown?.()
      } finally {
        settle(command.browserTabId)
      }
    },
    asToday: () => {
      try {
        write.here()
      } finally {
        settle(command.browserTabId)
      }
    },
    refused: () => settle(null)
  })
  if (!sent) {
    settle(null)
  }
  return sent
}
