// What a cloud terminal pane notes while its workspace is asleep (or waking), before the woken
// terminal attaches: the Rerun hint (JA-15 / WAKE-RERUN) and its pre-sleep output (WAKE-SCROLLBACK).
import type { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../shared/terminal/replay/terminal-scrollback-policy'
import {
  captureWakeProcessHint,
  cursorBelowLastText,
  readTerminalTail,
  scrollbackPaneKind,
  type WakePaneFacts
} from './cloud-wake-process-hints'
import { captureWakeScrollback } from './cloud-wake-scrollback'

/** The plain-text read-only copy saved at sleep for the pane's pre-sleep terminal, if any. */
async function readOnlyCopyLines(
  workspaceId: string,
  ptyId: string | null
): Promise<readonly string[] | null> {
  const handle = ptyId ? parseRemoteRuntimePtyId(ptyId)?.handle : null
  if (!handle) {
    return null
  }
  const snapshot = await window.api.orcaCloudOffline.getSnapshot({ workspaceId })
  return snapshot?.terminals.find((terminal) => terminal.handle === handle)?.lines ?? null
}

export function captureCloudPaneBeforeWake(args: {
  tabId: string
  leafId: string
  worktreeId: string
  terminal: Terminal
  /** When the workspace went to sleep, or null when unknown. */
  asleepSince: number | null
}): void {
  const { tabId, leafId, worktreeId, terminal } = args
  const state = useAppStore.getState()
  const lines = readTerminalTail(terminal)
  const facts: WakePaneFacts = {
    agentType: state.agentStatusByPaneKey[makePaneKey(tabId, leafId)]?.agentType ?? null,
    alternateScreen: terminal.buffer.active.type === 'alternate',
    cursorBelowText: cursorBelowLastText(terminal)
  }
  captureWakeProcessHint(leafId, lines, facts)
  const agentPane = scrollbackPaneKind(lines, facts) === 'agent'
  const ptyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null
  captureWakeScrollback(leafId, terminal, {
    sleptAt: args.asleepSince,
    agentPane,
    maxRows: normalizeDesktopTerminalScrollbackRows(state.settings?.terminalScrollbackRows),
    readOnlyCopy: () => readOnlyCopyLines(worktreeId, ptyId)
  })
}
