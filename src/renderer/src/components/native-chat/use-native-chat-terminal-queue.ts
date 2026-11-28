import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getRemoteRuntimePtyOwner } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import { toHostSessionPaneKey } from '../../../../shared/workspace-layout/terminal-surface-id'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY,
  NativeChatTerminalQueueSnapshotSchema,
  sameNativeChatTerminalQueueSnapshot,
  type NativeChatTerminalQueueSnapshot
} from '../../../../shared/native-chat/native-chat-terminal-queue'
import { projectQueuedMessageCards } from '../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { StructuredAgentSessionQueuedMessagesController } from './queue/use-structured-agent-session-queued-messages'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'

export function useNativeChatTerminalQueue(args: {
  paneKey: string
  ptyId: string | null
  enabled: boolean
  environmentId: string | null
  composerRef: RefObject<NativeChatComposerHandle | null>
}) {
  const { paneKey, ptyId, environmentId, composerRef } = args
  const appendText = useCallback(
    (text: string) => {
      if (!composerRef.current) {
        return false
      }
      composerRef.current.appendText(text)
      return true
    },
    [composerRef]
  )
  const target = useMemo<RuntimeClientTarget>(
    () =>
      (ptyId && getRemoteRuntimePtyOwner(ptyId)?.target) ||
      (environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }),
    [ptyId, environmentId]
  )
  const available =
    useStructuredAgentSessionHostCapabilityState(
      args.enabled ? target : null,
      NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY
    ) === 'supported'
  const enabled = args.enabled && available
  const scope = `${environmentId ?? ''}:${paneKey}:${ptyId ?? ''}`
  const current = useRef(scope)
  const generation = useRef(0)
  const seenEnabled = useRef(enabled)
  const [held, setHeld] = useState<{
    scope: string
    snapshot: NativeChatTerminalQueueSnapshot
  } | null>(null)
  const tail = useRef<Promise<unknown>>(Promise.resolve())
  const request = useCallback(
    (
      action:
        | { type: 'read' }
        | { type: 'enqueue'; messageId: string; text: string }
        | { type: 'delete'; messageIds: string[] }
        | { type: 'edit'; messageId: string }
    ) => {
      const started = generation.current
      const run = async () => {
        if (!enabled || !ptyId || current.current !== scope || generation.current !== started) {
          return null
        }
        const owner = getRemoteRuntimePtyOwner(ptyId)
        const target: RuntimeClientTarget =
          owner?.target ??
          (environmentId ? { kind: 'environment', environmentId } : { kind: 'local' })
        const terminal =
          owner?.terminal ??
          (
            await callRuntimeRpc<{ terminal: { handle: string } }>(target, 'terminal.resolvePane', {
              paneKey: toHostSessionPaneKey(paneKey)
            })
          ).terminal.handle
        const result = await callRuntimeRpc<unknown>(
          target,
          'nativeChat.terminalQueue',
          { terminal, action },
          { timeoutMs: 5_000 }
        )
        const parsed = NativeChatTerminalQueueSnapshotSchema.safeParse(result)
        if (!parsed.success) {
          return null
        }
        const stale = current.current !== scope || generation.current !== started
        if (stale) {
          return action.type === 'enqueue' ? parsed.data : null
        }
        if (current.current === scope) {
          setHeld((previous) =>
            previous?.scope === scope &&
            sameNativeChatTerminalQueueSnapshot(previous.snapshot, parsed.data)
              ? previous
              : { scope, snapshot: parsed.data }
          )
        }
        return parsed.data
      }
      const result = tail.current.catch(() => null).then(run)
      tail.current = result
      return result
    },
    [enabled, ptyId, scope, paneKey, environmentId]
  )
  useEffect(() => {
    current.current = scope
    if (seenEnabled.current !== enabled) {
      seenEnabled.current = enabled
      generation.current += 1
    }
  }, [scope, enabled])
  useEffect(() => {
    if (!enabled) {
      return
    }
    let reading = false
    const poll = async () => {
      if (reading) {
        return
      }
      reading = true
      try {
        await request({ type: 'read' })
      } catch {
        /* Retry after reconnect. */
      }
      reading = false
    }
    void poll()
    const stop = installWindowVisibilityInterval({ run: () => void poll(), intervalMs: 1_000 })
    return () => {
      stop()
      setHeld(null)
    }
  }, [enabled, request])
  const snapshot = enabled && held?.scope === scope ? held.snapshot : null
  const controller = useMemo<StructuredAgentSessionQueuedMessagesController>(
    () => ({
      cards: projectQueuedMessageCards(snapshot?.queuedMessages, [], {}).map((card) => ({
        ...card,
        waitsForAgent: true
      })),
      queueCapable: false,
      clearCapable: true,
      pause: null,
      queuePending: null,
      pending: () => null,
      resume: async () => false,
      clear: async () =>
        (await request({
          type: 'delete',
          messageIds: snapshot?.queuedMessages.map((card) => card.messageId) ?? []
        })) !== null,
      steer: async () => {},
      remove: async (id) => {
        await request({ type: 'delete', messageIds: [id] })
      },
      editCapable: true,
      editor: undefined,
      edit: async (id) => {
        const held = await request({ type: 'edit', messageId: id })
        const card = held?.queuedMessages.find((item) => item.messageId === id && item.paused)
        if (
          card &&
          appendText(
            card.body.blocks
              .flatMap((block) => (block.type === 'text' ? [block.text] : []))
              .join('\n')
          )
        ) {
          await request({ type: 'delete', messageIds: [id] })
        }
      },
      steerHead: () => false,
      isWorking: snapshot?.activity.state === 'working',
      holds: (messageId) =>
        snapshot?.queuedMessages.some((card) => card.messageId === messageId) === true,
      agentMail: [],
      agentMailEditable: () => false,
      mailLeads: false,
      stopping: false
    }),
    [snapshot, request, appendText]
  )
  const enqueue = useCallback(
    async (text: string) => {
      try {
        return (await request({ type: 'enqueue', messageId: createBrowserUuid(), text })) !== null
      } catch (error) {
        if (
          error instanceof RuntimeRpcCallError &&
          !isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
        ) {
          return false
        }
        throw error
      }
    },
    [request]
  )
  const state = enabled ? snapshot?.activity.state : null
  return {
    available,
    activity: enabled ? snapshot?.activity : undefined,
    working: state ? state === 'working' : undefined,
    awaitingInput: state ? state === 'waiting' : undefined,
    controller,
    enqueue
  }
}

export function queueSendEpoch(
  session: { hookWorking?: boolean; hookAwaitingInput?: boolean },
  liveWorking: boolean,
  turnEpoch: number | null
): number | null | undefined {
  return (session.hookWorking ?? liveWorking) || session.hookAwaitingInput ? turnEpoch : undefined
}
