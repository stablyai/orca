import type { PasteTerminalTextDetail } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { recordTerminalUserInputForLeaf } from '../terminal-input-activity'
import { pasteTextIntoTerminalPane } from './terminal-pane-paste-dispatch'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'

type HandleTerminalProgrammaticTextPasteArgs = {
  detail: PasteTerminalTextDetail | undefined
  tabId: string
  getManager: () => PaneManager | null
  getPaneTransports: () => Map<number, PtyTransport>
  focusAfterPaste?: () => boolean
}

export async function handleTerminalProgrammaticTextPaste({
  detail,
  tabId,
  getManager,
  getPaneTransports,
  focusAfterPaste = () => true
}: HandleTerminalProgrammaticTextPasteArgs): Promise<boolean> {
  if (!detail?.tabId || detail.tabId !== tabId || !detail.text) {
    return false
  }
  const manager = getManager()
  if (!manager) {
    return false
  }
  const panes = manager.getPanes()
  const pane =
    typeof detail.paneId === 'number'
      ? (panes.find((candidate) => candidate.id === detail.paneId) ?? null)
      : (manager.getActivePane() ?? panes[0])
  if (!pane) {
    return false
  }
  const paneTransports = getPaneTransports()
  const transport = paneTransports.get(pane.id)
  const ptyId = transport?.getPtyId() ?? null
  const isTargetCurrent = (): boolean =>
    isTerminalPanePasteTargetCurrent({
      manager: getManager(),
      paneTransports: getPaneTransports(),
      paneId: pane.id,
      leafId: pane.leafId,
      transport,
      ptyId
    })
  const result = await pasteTextIntoTerminalPane({
    pane,
    text: detail.text,
    source: 'programmatic',
    ptyId,
    runtime: resolveTerminalPasteRuntime({
      platform: getShortcutPlatform(),
      ptyId,
      transport
    }),
    transport,
    inputKind: 'driving',
    isTargetCurrent,
    canContinue: isTargetCurrent
  })
  if (result.status !== 'pasted') {
    return false
  }
  recordTerminalUserInputForLeaf(tabId, pane.leafId)
  if (focusAfterPaste()) {
    pane.terminal.focus()
  }
  return true
}
