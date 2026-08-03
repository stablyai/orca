import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import { sendNativeChatMessageVerified } from './native-chat-runtime-send'
import { cancelNativeChatPtySends, waitForNativeChatPtyIdle } from './native-chat-pty-send-queue'
import {
  createClaudeModelSwitchConfirmationObserver,
  type ClaudeModelSwitchConfirmationObserver
} from './claude-model-switch-confirmation'
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-command-dispatch'

export function useNativeChatSessionOptionCommand(args: {
  agent: AgentType
  disabled: boolean
  onSlashCommand?: (command: string) => void
  resolveTarget: () => NativeChatResolvedTarget | null
  setHistory: Dispatch<SetStateAction<HistoryState>>
}): { dispatch: NativeChatSessionOptionDispatchCommand; isDispatching: boolean } {
  const { agent, disabled, onSlashCommand, resolveTarget, setHistory } = args
  const mountedRef = useRef(true)
  const activeObserversRef = useRef(new Set<ClaudeModelSwitchConfirmationObserver>())
  const activeSendsRef = useRef(new Set<AbortController>())
  // Why: expose an in-flight flag so the composer can block a normal send while
  // an option command's body+delayed-Enter (and its confirmation observer) is
  // still writing to the same pty — otherwise the two write sequences interleave
  // on one input line and corrupt both.
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
        throw new Error('No live terminal is available.')
      }
      const sendController = new AbortController()
      activeSendsRef.current.add(sendController)
      // Why: block composer chat sends for the whole drain+observe+verify window.
      setIsDispatching(true)
      let observer: ClaudeModelSwitchConfirmationObserver | null = null
      try {
        // Why: chat sends keep a delayed Enter for 500ms. Drain them *before*
        // arming the model-switch observer so (a) that Enter cannot hit Claude's
        // confirmation UI and (b) any Ctrl+U cleanup is outside the observation
        // window (Ctrl+U mid-observe can miss "Set model to …" markers).
        cancelNativeChatPtySends(target.ptyId)
        await waitForNativeChatPtyIdle(target.ptyId)
        if (!mountedRef.current || sendController.signal.aborted) {
          throw new Error('Chat UI command was canceled because the composer closed.')
        }
        const detectClaudeConfirmation =
          options?.detectAgentInteraction === 'claude-model-switch-confirmation'
        if (detectClaudeConfirmation) {
          observer = createClaudeModelSwitchConfirmationObserver({
            ptyId: target.ptyId,
            settings: target.settings,
            expectedModelLabel: options?.expectedChoiceLabel ?? null
          })
          activeObserversRef.current.add(observer)
          await observer.ready
          if (!mountedRef.current || sendController.signal.aborted) {
            throw new Error('Chat UI command was canceled because the composer closed.')
          }
          // Why: arm only after the observer reaches the live PTY tail, then
          // submit immediately so historical output cannot satisfy the match.
          observer.arm()
        }
        const accepted = await sendNativeChatMessageVerified(
          target.settings,
          target.ptyId,
          command,
          sendController.signal
        )
        if (!accepted) {
          throw new Error('The terminal did not accept the command.')
        }
        // Why: start the model-switch detection clock only now that the command
        // has been accepted, so SSH/remote send latency doesn't eat the window
        // before the agent has responded.
        observer?.startDetection()
        onSlashCommand?.(command.trim())
        emitNativeChatMessageSent({
          agent,
          runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
        })
        setHistory((previous) => pushHistory(previous, command))
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
    [agent, disabled, onSlashCommand, resolveTarget, setHistory]
  )

  return { dispatch, isDispatching }
}
