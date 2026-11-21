import { useCallback } from 'react'
import type { AgentSessionOptionResult } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { commitStructuredAgentSessionModelDefault } from '../../../../../../../shared/agent-session/options/structured-agent-session-options'
import type { StructuredAgentSessionMutate } from '../../structured/writes/use-structured-agent-session-mutate'
import { enqueueSessionOptionSettingsWrite } from '../native-chat-session-option-settings-write'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'

type ModelDefaultSource = Pick<
  ReturnType<typeof useStructuredAgentSessionOptionState>,
  | 'controller'
  | 'activeOptionRecordRef'
  | 'isCurrentContext'
  | 'updateOptionState'
  | 'rereadOptions'
>

/** Default returns this chat, and the chats opened after it, to the agent's own model. */
export function useStructuredAgentSessionModelDefault(args: {
  agent: AgentType
  target: RuntimeClientTarget
  mutate: StructuredAgentSessionMutate
  source: ModelDefaultSource
}): () => Promise<void> {
  const { agent, target, mutate } = args
  const { controller, activeOptionRecordRef, isCurrentContext, updateOptionState, rereadOptions } =
    args.source
  return useCallback(async () => {
    // A pick still on its way would land after the reset and undo it.
    if (!isCurrentContext() || controller.pending().length > 0) {
      return
    }
    const record = activeOptionRecordRef.current
    const result = await mutate<AgentSessionOptionResult>(
      'agentSession.setOption',
      'agentSession.setOption',
      { key: 'model', value: null }
    )
    if (!result?.modelDefault) {
      return
    }
    // New chats follow too, on the host that paired this chat, as remembered picks are written.
    void controller
      .request((options) =>
        enqueueSessionOptionSettingsWrite(target, { type: 'clear-model', agent }, options)
      )
      .catch(() => undefined)
    if (!isCurrentContext() || activeOptionRecordRef.current !== record) {
      return
    }
    // Accepted picks overlay the read until it retires them; this answer already replaces them.
    controller.retire(controller.captureRead())
    updateOptionState((state) =>
      commitStructuredAgentSessionModelDefault(state, result.options ?? {})
    )
    rereadOptions()
  }, [
    activeOptionRecordRef,
    agent,
    controller,
    isCurrentContext,
    mutate,
    rereadOptions,
    target,
    updateOptionState
  ])
}
