import { useAppStore } from '@/store/index'
import { getTerminalPtyOwnershipIdentity } from '@/store/terminals/terminal-tab-retirement'
import {
  getTerminalNoticeLifetime,
  retireTerminalNoticeLifetime,
  type TerminalNoticeLifetime
} from '../provider-notices/terminal-notice-lifetime'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import { terminalPaneHasOtherOwner } from './terminal-pane-retirement-ownership'

/** Capture before a final close can erase the binding or await main's frame. */
export function captureTerminalPaneNoticeRetirement(args: {
  tabId: string
  leafId: string
  worktreeId: string | null
  ptyId?: string | null
  lifetime?: TerminalNoticeLifetime
  transport?: PtyTransport
  getTransports?: () => ReadonlyMap<number, PtyTransport>
}): () => void {
  const lifetime = args.lifetime ?? (args.ptyId ? getTerminalNoticeLifetime(args.ptyId) : undefined)
  if (!lifetime || lifetime.retired) {
    return () => {}
  }
  const identity = getTerminalPtyOwnershipIdentity(
    useAppStore.getState(),
    lifetime.ptyId,
    args.worktreeId
  )
  return () => {
    if (lifetime.retired) {
      return
    }
    const siblings = new Map(
      [...(args.getTransports?.() ?? [])].filter(([, transport]) => transport !== args.transport)
    )
    if (
      !terminalPaneHasOtherOwner(
        {
          getState: useAppStore.getState,
          tabId: args.tabId,
          getTransports: () => siblings
        },
        identity,
        args.worktreeId,
        args.leafId
      )
    ) {
      retireTerminalNoticeLifetime(lifetime)
    }
  }
}
