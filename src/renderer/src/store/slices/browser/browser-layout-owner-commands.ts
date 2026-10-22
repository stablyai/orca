// A browser page create, close, convert or profile switch in a layout-owner build: the window sends
// the command first and changes nothing until main answers. Main's frame shows the tab's own
// fields (its pages, its profile); the window then writes what only it holds (each page's state).
// A refusal leaves the tab as it was.

import { sendLayoutApply, type WindowLayoutCommand } from '@/runtime/layout-apply-send'
import { beginPendingTab } from '@/runtime/layout-owner-pending-tabs'
import type { BrowserSliceGet } from './browser-slice-contract'

type BrowserLayoutCommand = Extract<
  WindowLayoutCommand,
  { type: 'openBrowserPage' | 'closeBrowserPage' | 'replaceBrowserPage' | 'setBrowserTabProfile' }
>

/**
 * False when main is not asked (a paired server owns the workspace's layout): the caller writes
 * the change as today. `here` is today's write, for a twin main may route to a paired server;
 * `shown` runs once main's frame is in.
 */
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
