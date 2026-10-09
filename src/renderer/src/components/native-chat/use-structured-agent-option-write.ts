import { toast } from 'sonner'
import { useCallback } from 'react'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session-wire'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode
} from '../../../../shared/agent-chat-permission-mode'
import {
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { holdStructuredAgentSessionLaunchOption } from '@/lib/structured-agent-session-launch-options'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import type { useAgentSessionPermissionState } from '../../../../shared/use-agent-session-permission-state'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

export function useStructuredAgentOptionWrite(args: {
  state: ReturnType<typeof useStructuredAgentSessionOptionState>
  permissionState: ReturnType<typeof useAgentSessionPermissionState>
  fence: number | null
  sessionId: string
  target: RuntimeClientTarget
  mutate: StructuredAgentSessionMutate
  launchSeedOptions?: Readonly<Record<string, string>>
  rememberOptionPicks: (
    view: StructuredAgentSessionOptionState,
    committed: Readonly<Record<string, string>>
  ) => void
}) {
  const {
    permissionState,
    fence,
    sessionId,
    target,
    mutate,
    launchSeedOptions,
    rememberOptionPicks
  } = args
  const {
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionRef,
    optionMutationGeneration,
    refreshOptionsAfterWrite,
    updateOptionState
  } = args.state
  const sendStructuredOption = useCallback(
    async (id: string, encoded: string): Promise<boolean> => {
      const currentState = optionStateRef.current
      const targetRecord = currentState.record
      const permissionWrite = permissionState.begin(
        id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID && isAgentChatPermissionMode(encoded)
          ? encoded
          : undefined
      )
      const mutationGeneration = ++optionMutationGeneration.current
      const isCurrent = (): boolean =>
        activeOptionRecordRef.current === targetRecord &&
        optionMutationGeneration.current === mutationGeneration
      pendingOptionRef.current = id
      updateOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const admittedFence =
          id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID ? permissionState.getFence() : fence
        const heldPick =
          admittedFence === null
            ? holdStructuredAgentSessionLaunchOption(sessionId, id, encoded, target)
            : null
        const outcome = heldPick ? await heldPick : null
        if (outcome?.kind === 'refused') {
          toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
        }
        const result =
          admittedFence === null
            ? outcome?.kind === 'accepted'
              ? { options: outcome.options, permissionFact: outcome.permissionFact }
              : null
            : await mutate<AgentSessionOptionResult>(
                'agentSession.setOption',
                'agentSession.setOption',
                { key: id, value: encoded },
                ...(id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
                  ? ([permissionState.getFence()] as const)
                  : [])
              )
        if (result) {
          permissionState.confirmWrite(
            permissionWrite,
            result.options?.permissionMode ??
              (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID ? encoded : undefined),
            result.permissionFact
          )
        }
        if (result && isCurrent()) {
          const committed = result.options ?? { [id]: encoded }
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, committed)
              : current
          )
          // The launch seed names the model an effort-only pick was made under. The chat's
          // permission mode is its own and never becomes the next chat's default.
          if (id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
            rememberOptionPicks(
              structuredAgentSessionOptionView(currentState, launchSeedOptions, NO_HELD_OPTIONS),
              committed
            )
          }
          refreshOptionsAfterWrite(targetRecord, isCurrent)
        }
        return Boolean(result)
      } finally {
        permissionState.confirmWrite(permissionWrite)
        if (isCurrent()) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
      }
    },
    [
      activeOptionRecordRef,
      fence,
      launchSeedOptions,
      mutate,
      optionMutationGeneration,
      optionStateRef,
      pendingOptionRef,
      refreshOptionsAfterWrite,
      rememberOptionPicks,
      sessionId,
      target,
      updateOptionState,
      permissionState
    ]
  )
  return sendStructuredOption
}
