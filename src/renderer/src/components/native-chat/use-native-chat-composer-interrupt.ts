import { useCallback } from 'react'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'

// Why: a plain ESC byte is what the agent TUIs read as the interrupt key over a
// PTY (matching how xterm forwards Escape). The richer interrupt-intent
// inference (agent-interrupt-intent.ts) is driven by the existing PTY input
// observers, so writing ESC through the same send path feeds that machinery.
const ESC = '\x1b'

/** Stop the hosted agent: the structured lane's own stop when a turn is running,
 *  else the ESC keystroke the TUI reads as its interrupt. */
export function useNativeChatComposerInterrupt(args: {
  cancelPendingSends: () => void
  isWorking: boolean
  onStop?: () => void
  resolveTarget: () => NativeChatResolvedTarget | null
}): () => void {
  const { cancelPendingSends, isWorking, onStop, resolveTarget } = args
  return useCallback(() => {
    cancelPendingSends()
    if (isWorking && onStop) {
      onStop()
      return
    }
    const target = resolveTarget()
    if (target) {
      sendRuntimePtyInput(target.settings, target.ptyId, ESC, 'driving')
    }
  }, [cancelPendingSends, isWorking, onStop, resolveTarget])
}
