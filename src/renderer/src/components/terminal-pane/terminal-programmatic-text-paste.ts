import type { PasteTerminalTextDetail } from '@/constants/terminal'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { getConnectionId } from '@/lib/connection-context'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { executeTerminalPastePlan, planTerminalPasteWithYield } from './terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

type HandleTerminalProgrammaticTextPasteArgs = {
  detail: PasteTerminalTextDetail | undefined
  tabId: string
  worktreeId: string
  getManager: () => PaneManager | null
  getPaneTransports: () => Map<number, PtyTransport>
}

export type PasteTextIntoTerminalPaneArgs = {
  text: string
  tabId: string
  worktreeId: string
  pane: ManagedPane
  transport: PtyTransport | undefined
  getManager: () => PaneManager | null
  getPaneTransports: () => Map<number, PtyTransport>
  focusAfterPaste?: boolean
  forceBracketedPaste?: boolean
  canContinue?: () => boolean
}

/** Runs programmatic composer/file pastes through the same bounded local/remote path. */
export async function pasteTextIntoTerminalPane({
  text,
  tabId,
  worktreeId,
  pane,
  transport,
  getManager,
  getPaneTransports,
  focusAfterPaste = false,
  forceBracketedPaste = false,
  canContinue
}: PasteTextIntoTerminalPaneArgs): Promise<boolean> {
  const ptyId = transport?.getPtyId() ?? null
  const platform = getShortcutPlatform()
  const connectionId = getConnectionId(worktreeId) ?? null
  const plan = await planTerminalPasteWithYield({
    text,
    source: 'programmatic',
    target: {
      kind: 'terminal',
      paneId: pane.id,
      leafId: pane.leafId,
      ptyId,
      runtime: resolveTerminalPasteRuntime({
        platform,
        ptyId,
        connectionId,
        remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
        transport
      })
    },
    terminalBracketedPasteMode: pane.terminal.modes?.bracketedPasteMode === true,
    forceBracketedPaste
  })
  const targetIsCurrent = (): boolean =>
    (canContinue?.() ?? true) &&
    isTerminalPanePasteTargetCurrent({
      manager: getManager(),
      paneTransports: getPaneTransports(),
      paneId: pane.id,
      leafId: pane.leafId,
      transport,
      ptyId
    })
  let pasteBlocked = false
  const result = await executeTerminalPastePlan(plan, {
    pasteText: (nextText, options) => {
      // The executor defers writes to a microtask, after its continuation check.
      if (!targetIsCurrent()) {
        pasteBlocked = true
        return
      }
      pasteTerminalText(pane.terminal, nextText, options)
    },
    writePty: (data) => targetIsCurrent() && writeTerminalPastePtyInput(transport, data),
    isTargetCurrent: targetIsCurrent,
    canContinue: targetIsCurrent
  })
  if (pasteBlocked || result.status !== 'pasted') {
    return false
  }
  recordTerminalUserInputForLeaf(tabId, pane.leafId)
  if (focusAfterPaste) {
    pane.terminal.focus()
  }
  return true
}

export function handleTerminalProgrammaticTextPaste({
  detail,
  tabId,
  worktreeId,
  getManager,
  getPaneTransports
}: HandleTerminalProgrammaticTextPasteArgs): void {
  if (!detail?.tabId || detail.tabId !== tabId || !detail.text) {
    return
  }
  const manager = getManager()
  if (!manager) {
    return
  }
  const panes = manager.getPanes()
  const pane =
    typeof detail.paneId === 'number'
      ? (panes.find((candidate) => candidate.id === detail.paneId) ?? null)
      : (manager.getActivePane() ?? panes[0])
  if (!pane) {
    return
  }
  void pasteTextIntoTerminalPane({
    text: detail.text,
    tabId,
    worktreeId,
    pane,
    transport: getPaneTransports().get(pane.id),
    getManager,
    getPaneTransports,
    focusAfterPaste: true
  })
}
