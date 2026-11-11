import { useCallback, useEffect, useId, useRef } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { sendRuntimePtyInput } from '@/runtime/hosted-terminals/input/runtime-terminal-input-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'

// Write ESC through the PTY path so existing input observers infer interrupt intent just as for xterm.
const ESC = '\x1b'
const CONFIRM_ESCAPE_MS = 2_000

/** Use structured Stop for a running turn; otherwise send the TUI’s ESC interrupt. */
export function useNativeChatComposerInterrupt(
  scopeKey: string,
  draft: string,
  args: {
    /** A prompt card owns the input: Escape must not reach the agent as Deny. */
    inert?: boolean
    cancelPendingSends: () => void
    isWorking: boolean
    onStop?: () => void
    resolveTarget: () => NativeChatResolvedTarget | null
  }
): { interrupt: () => void; confirmEscape: (repeated?: boolean) => void } {
  const { inert, cancelPendingSends, isWorking, onStop, resolveTarget } = args
  const t = useTranslate()
  const noticeId = useId()
  const pending = useRef<{ scopeKey: string; draft: string; at: number } | null>(null)
  const clearConfirmation = useCallback(() => {
    pending.current = null
    toast.dismiss(noticeId)
  }, [noticeId])
  useEffect(() => clearConfirmation, [scopeKey, draft, inert, isWorking, clearConfirmation])
  const interrupt = useCallback(() => {
    if (inert) {
      return
    }
    clearConfirmation()
    cancelPendingSends()
    if (isWorking && onStop) {
      onStop()
      return
    }
    const target = resolveTarget()
    if (target) {
      sendRuntimePtyInput(target.ptyId, ESC, 'driving')
    }
  }, [inert, clearConfirmation, cancelPendingSends, isWorking, onStop, resolveTarget])
  const confirmEscape = useCallback(
    (repeated = false) => {
      if (inert || repeated) {
        return
      }
      if (isWorking) {
        const now = Date.now()
        const first = pending.current
        const elapsed = first ? now - first.at : -1
        if (
          !first ||
          first.scopeKey !== scopeKey ||
          first.draft !== draft ||
          elapsed < 0 ||
          elapsed > CONFIRM_ESCAPE_MS
        ) {
          pending.current = { scopeKey, draft, at: now }
          toast.message(
            t('components.native-chat.composer.confirmEscapeStop', 'Press Esc again to stop'),
            { id: noticeId, duration: CONFIRM_ESCAPE_MS }
          )
          return
        }
      }
      interrupt()
    },
    [scopeKey, draft, inert, isWorking, interrupt, noticeId, t]
  )
  return { interrupt, confirmEscape }
}
