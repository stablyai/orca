import { structuredAgentSessionOptionSnapshot } from '../../../../shared/agent-session/options/structured-agent-session-option-snapshot'
import { useCallback, type RefObject } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import {
  commitStructuredAgentSessionModelDefault,
  commitStructuredAgentSessionOptionValues
} from '../../../../shared/agent-session/options/structured-agent-session-options'
import {
  STRUCTURED_MODEL_DEFAULT_PICK,
  beginStructuredOptionPick,
  isLatestStructuredOptionPick,
  settleStructuredOptionPick
} from '../../../../shared/structured-agent-session-option-pick-book'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'

export function useStructuredAgentSessionModelDefault(args: {
  agent: AgentType
  target: RuntimeClientTarget
  mutate: StructuredAgentSessionMutate
  takesModelDefault: boolean
  acceptsPicks: boolean
  fence: number | null
  launchSeedOptions: Readonly<Record<string, string>> | undefined
  lockSnapshotRef: RefObject<(snapshot: SessionOptionDescriptor[]) => SessionOptionDescriptor[]>
  source: Pick<
    ReturnType<typeof useStructuredAgentSessionOptionState>,
    | 'optionView'
    | 'optionStateRef'
    | 'activeOptionRecordRef'
    | 'controller'
    | 'optionPicks'
    | 'writes'
    | 'beginOptionWrite'
    | 'isCurrentContext'
    | 'updateOptionState'
  >
}) {
  const {
    agent,
    target,
    mutate,
    takesModelDefault,
    acceptsPicks,
    fence,
    launchSeedOptions,
    lockSnapshotRef
  } = args
  const {
    optionView,
    optionStateRef,
    activeOptionRecordRef,
    optionPicks,
    controller,
    writes,
    beginOptionWrite,
    isCurrentContext,
    updateOptionState
  } = args.source
  return useCallback(
    async (id: string) => {
      const snapshot = () => ({
        snapshot: lockSnapshotRef.current(
          structuredAgentSessionOptionSnapshot(
            optionView(optionStateRef.current, launchSeedOptions, {})
          )
        )
      })
      if (
        id !== 'model' ||
        !takesModelDefault ||
        !acceptsPicks ||
        fence === null ||
        !isCurrentContext() ||
        writes.current.count > 0 ||
        controller.pending().length > 0
      ) {
        return snapshot()
      }
      const targetRecord = optionStateRef.current.record
      const finish = beginOptionWrite(id)
      const pick = beginStructuredOptionPick(
        optionPicks.current,
        id,
        STRUCTURED_MODEL_DEFAULT_PICK,
        false
      )
      const sameRecord = () => isCurrentContext() && activeOptionRecordRef.current === targetRecord
      const current = () => sameRecord() && isLatestStructuredOptionPick(optionPicks.current, pick)
      updateOptionState((state) => ({ ...state }))
      let accepted = false
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: null }
        )
        accepted = Boolean(result)
        if (result && current()) {
          controller.abandon()
          controller.setModelDefault(result.modelDefault === true)
          updateOptionState((state) =>
            result.modelDefault
              ? commitStructuredAgentSessionModelDefault(state, result.options ?? {})
              : {
                  ...commitStructuredAgentSessionOptionValues(state, result.options ?? {}),
                  modelDefault: false
                }
          )
          if (result.modelDefault) {
            void enqueueSessionOptionSettingsWrite(target, { type: 'clear-model', agent })
          }
        }
        return snapshot()
      } finally {
        if (sameRecord()) {
          settleStructuredOptionPick(optionPicks.current, pick)
        }
        if (current()) {
          updateOptionState((state) => ({ ...state }))
        }
        finish(accepted && current())
      }
    },
    [
      acceptsPicks,
      activeOptionRecordRef,
      agent,
      beginOptionWrite,
      fence,
      isCurrentContext,
      launchSeedOptions,
      lockSnapshotRef,
      mutate,
      optionStateRef,
      optionView,
      optionPicks,
      controller,
      writes,
      takesModelDefault,
      target,
      updateOptionState
    ]
  )
}
