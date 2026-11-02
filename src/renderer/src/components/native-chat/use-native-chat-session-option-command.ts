import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { sendNativeChatMessageVerified, typeNativeChatCommand } from './native-chat-runtime-send'
import { cancelNativeChatPtySends, waitForNativeChatPtyIdle } from './native-chat-pty-send-queue'
import {
  createClaudeModelSwitchConfirmationObserver,
  type ClaudeModelSwitchConfirmationObserver
} from './claude-model-switch-confirmation'
import type { NativeChatSessionOptionDispatchCommand } from '../../../../shared/native-chat-session-option-dispatch'
import { translate } from '@/i18n/i18n'

export function useNativeChatSessionOptionCommand(args: {
  agent: AgentType
  disabled: boolean
  onSlashCommand?: (command: string) => void
  onSubmitted?: () => void
  resolveTarget: () => NativeChatResolvedTarget | null
}): { dispatch: NativeChatSessionOptionDispatchCommand; isDispatching: boolean } {
  const { agent, disabled, onSlashCommand, onSubmitted, resolveTarget } = args
  const mountedRef = useRef(true)
  const activeObserversRef = useRef(new Set<ClaudeModelSwitchConfirmationObserver>())
  const activeSendsRef = useRef(new Set<AbortController>())
  // Block composer sends until option-command writes and confirmation finish to prevent interleaved PTY input.
  const [isDispatching, setIsDispatching] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    const observers = activeObserversRef.current
    const sends = activeSendsRef.current
    return () => {
      mountedRef.current = false
      for (const send of sends) {
        send.abort()
      }
      sends.clear()
      for (const observer of observers) {
        observer.dispose()
      }
      observers.clear()
    }
  }, [])

  const dispatch = useCallback(
    async (command, options) => {
      const target = resolveTarget()
      if (!target || disabled) {
        throw new Error(
          translate(
            'components.native-chat.sessionOption.noLiveTerminal',
            'No live terminal is available.'
          )
        )
      }
      onSubmitted?.()
      const sendController = new AbortController()
      activeSendsRef.current.add(sendController)
      setIsDispatching(true)
      let observer: ClaudeModelSwitchConfirmationObserver | null = null
      try {
        // Drain delayed chat Enter/Ctrl+U before observing so they cannot answer the model dialog or hide confirmation markers.
        cancelNativeChatPtySends(target.ptyId)
        await waitForNativeChatPtyIdle(target.ptyId)
        if (!mountedRef.current || sendController.signal.aborted) {
          throw new Error(
            translate(
              'components.native-chat.sessionOption.commandCanceled',
              'Chat UI command was canceled because the composer closed.'
            )
          )
        }
        const detectClaudeConfirmation =
          options?.detectAgentInteraction === 'claude-model-switch-confirmation'
        if (detectClaudeConfirmation) {
          observer = createClaudeModelSwitchConfirmationObserver({
            ptyId: target.ptyId,
            expectedModelLabel: options?.expectedChoiceLabel ?? null
          })
          activeObserversRef.current.add(observer)
          await observer.ready
          if (!mountedRef.current || sendController.signal.aborted) {
            throw new Error(
              translate(
                'components.native-chat.sessionOption.commandCanceled',
                'Chat UI command was canceled because the composer closed.'
              )
            )
          }
          // Arm at the live tail immediately before submitting so historical output cannot confirm the switch.
          observer.arm()
        }
        const accepted =
          agent === 'codex'
            ? await typeNativeChatCommand(target.ptyId, command, sendController.signal)
            : await sendNativeChatMessageVerified(target.ptyId, command, sendController.signal)
        if (!accepted) {
          throw new Error(
            translate(
              'components.native-chat.sessionOption.commandRejected',
              'The terminal did not accept the command.'
            )
          )
        }
        // Start detection after acceptance so remote send latency cannot consume the response window.
        observer?.startDetection()
        onSlashCommand?.(command.trim())
        emitNativeChatMessageSent({
          agent,
          runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
        })
        const outcome = observer ? await observer.result : undefined
        return { outcome }
      } finally {
        activeSendsRef.current.delete(sendController)
        setIsDispatching(activeSendsRef.current.size > 0)
        if (observer) {
          activeObserversRef.current.delete(observer)
          observer.dispose()
        }
      }
    },
    [agent, disabled, onSlashCommand, onSubmitted, resolveTarget]
  )

  return { dispatch, isDispatching }
}
