import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { resolveNativeTerminalDropPane } from './terminal-drop-pane-resolution'
import { isImageDropPath } from './terminal-drop-image-path'

export const TERMINAL_RICH_INPUT_NATIVE_DROP_EVENT = 'terminal-rich-input-native-drop'

export type TerminalRichInputNativeDropDetail =
  | { phase: 'start'; imagePending: boolean }
  | { phase: 'resolved'; paths: string[] }
  | { phase: 'end' }

export type TerminalRichInputDropPathReceiver = {
  begin: (sourcePaths: string[]) => void
  receive: (paths: string[]) => boolean
  end: () => void
}

function dispatchTerminalRichInputNativeDrop(
  container: HTMLElement,
  detail: TerminalRichInputNativeDropDetail
): void {
  container.dispatchEvent(
    new CustomEvent<TerminalRichInputNativeDropDetail>(TERMINAL_RICH_INPUT_NATIVE_DROP_EVENT, {
      detail
    })
  )
}

export function getTerminalRichInputDropPathReceiver(
  manager: PaneManager,
  paneLeafId: string | undefined
): TerminalRichInputDropPathReceiver | undefined {
  const pane = resolveNativeTerminalDropPane(manager, paneLeafId)
  if (!pane || pane.container.dataset.terminalRichInputOpen === undefined) {
    return undefined
  }
  return {
    begin: (sourcePaths) =>
      dispatchTerminalRichInputNativeDrop(pane.container, {
        phase: 'start',
        imagePending: sourcePaths.some(isImageDropPath)
      }),
    receive: (paths) => {
      if (pane.container.dataset.terminalRichInputOpen === undefined) {
        return false
      }
      dispatchTerminalRichInputNativeDrop(pane.container, { phase: 'resolved', paths })
      return true
    },
    end: () => dispatchTerminalRichInputNativeDrop(pane.container, { phase: 'end' })
  }
}
