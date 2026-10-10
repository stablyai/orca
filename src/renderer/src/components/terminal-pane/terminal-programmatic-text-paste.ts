import type { PasteTerminalTextDetail } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { getConnectionId } from '@/lib/connection-context'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { pasteTextIntoTerminalPane } from './terminal-pane-paste-dispatch'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'

type HandleTerminalProgrammaticTextPasteArgs = {
  detail: PasteTerminalTextDetail | undefined
  tabId: string
  worktreeId: string
  getManager: () => PaneManager | null
  getPaneTransports: () => Map<number, PtyTransport>
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
  const paneTransports = getPaneTransports()
  const transport = paneTransports.get(pane.id)
  const ptyId = transport?.getPtyId() ?? null
  const connectionId = getConnectionId(worktreeId) ?? null
  const isTargetCurrent = (): boolean =>
    isTerminalPanePasteTargetCurrent({
      manager: getManager(),
      paneTransports: getPaneTransports(),
      paneId: pane.id,
      leafId: pane.leafId,
      transport,
      ptyId
    })
  void pasteTextIntoTerminalPane({
    pane,
    text: detail.text,
    source: 'programmatic',
    ptyId,
    runtime: resolveTerminalPasteRuntime({
      platform: getShortcutPlatform(),
      ptyId,
      connectionId,
      remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
      transport
    }),
    transport,
    inputKind: 'driving',
    isTargetCurrent,
    canContinue: isTargetCurrent
  }).then((result) => {
    if (result.status !== 'pasted') {
      return
    }
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  })
}
