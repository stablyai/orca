import { useCallback } from 'react'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'

// Write ESC through the PTY path so existing input observers infer interrupt intent just as for xterm.
const ESC = '\x1b'

/** Use structured Stop for a running turn; otherwise send the TUI’s ESC interrupt. */
export function useNativeChatComposerInterrupt(args: {
  /** A prompt card owns the input: Escape must not reach the agent as Deny. */
  inert?: boolean
  cancelPendingSends: () => void
  isWorking: boolean
  onStop?: () => void
  resolveTarget: () => NativeChatResolvedTarget | null
}): () => void {
  const { inert, cancelPendingSends, isWorking, onStop, resolveTarget } = args
  return useCallback(() => {
    if (inert) {
      return
    }
    cancelPendingSends()
    if (isWorking && onStop) {
      onStop()
      return
    }
    const target = resolveTarget()
    if (target) {
      sendRuntimePtyInput(target.ptyId, ESC, 'driving')
    }
  }, [inert, cancelPendingSends, isWorking, onStop, resolveTarget])
}
