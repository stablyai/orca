import { useCallback } from 'react'
import type { TerminalPaneTitleController } from './use-terminal-pane-title-state'
import { readTerminalCursorLineContext } from '../../../../shared/terminal/input/terminal-cursor-line-context'
import { readTerminalComposerTypedText } from '../../../../shared/terminal/input/terminal-composer-draft'

export function useTerminalPaneChatReadback(
  managerRef: TerminalPaneTitleController['managerRef'],
  chatLeafId: string | null
) {
  const findNativeChatPane = useCallback(
    () =>
      chatLeafId
        ? managerRef.current?.getPanes().find((candidate) => candidate.leafId === chatLeafId)
        : undefined,
    [chatLeafId, managerRef]
  )
  const readNativeChatTerminalScreen = useCallback(
    (): string | null => findNativeChatPane()?.serializeAddon.serialize({ scrollback: 0 }) ?? null,
    [findNativeChatPane]
  )
  const readNativeChatTerminalDraft = useCallback((): string | null => {
    const pane = findNativeChatPane()
    return pane
      ? readTerminalComposerTypedText(
          readTerminalCursorLineContext(pane.terminal, pane.terminal.rows)
        )
      : null
  }, [findNativeChatPane])

  return { readNativeChatTerminalScreen, readNativeChatTerminalDraft }
}
