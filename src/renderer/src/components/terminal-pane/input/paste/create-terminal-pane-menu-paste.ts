import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalPasteSource } from './terminal-paste-model'
import { pasteTerminalPaneMenuClipboard } from './terminal-pane-menu-paste'
import type { UseTerminalPaneContextMenuDeps } from '../../context-menu/terminal-pane-context-menu-types'

export function createTerminalPaneMenuPaste({
  managerRef,
  paneTransportsRef,
  tabId,
  worktreeId,
  fallbackCwd,
  onPasteError,
  forceBracketedMultilineTextPaste,
  clipboardImageEnterHold,
  resolveMenuPane
}: Pick<
  UseTerminalPaneContextMenuDeps,
  | 'managerRef'
  | 'paneTransportsRef'
  | 'tabId'
  | 'worktreeId'
  | 'fallbackCwd'
  | 'onPasteError'
  | 'forceBracketedMultilineTextPaste'
  | 'clipboardImageEnterHold'
> & { resolveMenuPane: () => ManagedPane | null }) {
  const pasteResolvedPane = async (
    source: Extract<TerminalPasteSource, 'context-menu' | 'right-click'>
  ): Promise<void> =>
    pasteTerminalPaneMenuClipboard(
      {
        managerRef,
        paneTransportsRef,
        tabId,
        worktreeId,
        cwd: fallbackCwd,
        forceBracketedMultilineTextPaste,
        onPasteError,
        clipboardImageEnterHold
      },
      resolveMenuPane(),
      source
    )
  return { pasteResolvedPane }
}
