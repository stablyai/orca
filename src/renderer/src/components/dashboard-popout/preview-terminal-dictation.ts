import type { Terminal } from '@xterm/xterm'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { registerDictationPreviewTarget } from '../dictation/dictation-preview-target'
import { createPreviewTextPaster } from './preview-terminal-paste'

export function installPreviewTerminalDictation(args: {
  ptyId: string
  getPtyId: () => string
  container: HTMLElement
  terminal: Terminal
  getTerminalInput: () => DashboardCardTerminalInput | null
}): () => void {
  let disposed = false
  const unregister = registerDictationPreviewTarget(args.container, () => {
    const terminalInput = args.getTerminalInput()
    return {
      kind: 'terminal-preview',
      insertText: createPreviewTextPaster({
        ptyId: args.ptyId,
        terminal: args.terminal,
        terminalInput,
        source: 'programmatic',
        isTargetCurrent: () => {
          const current = args.getTerminalInput()
          return (
            !disposed &&
            args.container.isConnected &&
            args.getPtyId() === args.ptyId &&
            current?.connectionId === terminalInput?.connectionId &&
            current?.runtimeEnvironmentId === terminalInput?.runtimeEnvironmentId
          )
        }
      })
    }
  })
  return () => {
    disposed = true
    unregister()
  }
}
