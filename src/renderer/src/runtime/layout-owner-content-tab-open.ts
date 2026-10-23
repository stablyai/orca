// A browser, chat or simulator tab open in a layout-owner build: the window proposes the ids and
// sends the open; main's frame draws the tab with the window's facts for it, and only then does
// the window act on it (select, focus). A caller acting on the tab waits with `afterPendingTab`.

import { sendLayoutApply, type WindowLayoutCommand } from './layout-apply-send'
import { beginPendingTab } from './layout-owner-pending-tabs'
import { expectTabFacts, type PendingTabFacts } from './layout-owner-pending-tab-facts'

type ContentTabOpenCommand = Extract<
  WindowLayoutCommand,
  { type: 'openBrowserTab' | 'openAgentSessionTab' | 'openSimulatorTab' }
>

export type ContentTabOpen = {
  worktreeId: string
  /** What the tab shows: a browser record, chat session or the simulator tab itself. */
  entityId: string
  command: ContentTabOpenCommand
  facts: Omit<PendingTabFacts, 'worktreeId' | 'tabId'>
  /** Runs once main's frame drew the tab, with the id it shows. */
  shown: (tabId: string) => void
  /** Today's draw, for a twin main may route to a paired server; the tab id it drew, if any. */
  drawHere: () => string | null
}

/** False when main is not asked (a paired server owns the workspace's layout); draw as today. */
export function openContentTabThroughLayoutOwner(
  state: Parameters<typeof sendLayoutApply>[0],
  open: ContentTabOpen
): boolean {
  const { worktreeId, command } = open
  const groupId = command.groupId
  const settle = beginPendingTab(command.tabId, worktreeId, open.entityId, {
    kind: 'open',
    groupId
  })
  const release = expectTabFacts({ ...open.facts, worktreeId, tabId: command.tabId })
  const sent = sendLayoutApply(state, worktreeId, command, {
    apply: (result) => {
      const shownId = result.tabId ?? command.tabId
      // The frame drew the tab with these facts; the store holds them from here on.
      release()
      try {
        open.shown(shownId)
      } finally {
        settle(shownId)
      }
    },
    asToday: () => {
      release()
      settle(open.drawHere())
    },
    refused: () => {
      release()
      settle(null)
    }
  })
  if (!sent) {
    release()
    settle(null)
  }
  return sent
}
