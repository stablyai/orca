import { useCallback } from 'react'
import {
  STRUCTURED_MODEL_DEFAULT_PICK,
  beginStructuredOptionPick,
  settleStructuredOptionPick
} from '../../../../../../../shared/agent-session/options/selection/structured-agent-session-option-pick-book'
import type { StructuredAgentSessionMutate } from '../../structured/writes/use-structured-agent-session-mutate'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'

type ModelDefaultWriteSource = Pick<
  ReturnType<typeof useStructuredAgentSessionOptionState>,
  | 'controller'
  | 'activeOptionRecordRef'
  | 'isCurrentContext'
  | 'updateOptionState'
  | 'optionPicks'
  | 'writes'
  | 'beginOptionWrite'
>

function returnsModelDefault(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'modelDefault' in result &&
    result.modelDefault === true
  )
}

type ModelDefaultWrite = ModelDefaultWriteSource & { mutate: StructuredAgentSessionMutate }

/** The Default reset's write: it holds the model until the host answers, so sends, picks and reads
 *  wait for it, and answers null while another reset holds it. */
async function writeStructuredAgentSessionModelDefault<T>(
  write: ModelDefaultWrite,
  args: Parameters<StructuredAgentSessionMutate>
): Promise<T | null> {
  const { mutate, controller, activeOptionRecordRef, isCurrentContext, updateOptionState } = write
  const { optionPicks, writes, beginOptionWrite } = write
  if (writes.current.count > 0) {
    return null
  }
  const record = activeOptionRecordRef.current
  const current = () => isCurrentContext() && activeOptionRecordRef.current === record
  const finish = beginOptionWrite('model')
  const pick = beginStructuredOptionPick(
    optionPicks.current,
    'model',
    STRUCTURED_MODEL_DEFAULT_PICK,
    false
  )
  updateOptionState((state) => ({ ...state }))
  let result: T | null = null
  try {
    result = await mutate<T>(...args)
    return result
  } finally {
    if (current()) {
      settleStructuredOptionPick(optionPicks.current, pick)
      // Value picks settling before the next read must not adopt a model for new chats.
      if (returnsModelDefault(result)) {
        controller.setModelDefault(true)
      }
      updateOptionState((state) => ({ ...state }))
    }
    finish(result !== null && current())
  }
}

export function useStructuredAgentSessionModelDefaultWrite(
  mutate: StructuredAgentSessionMutate,
  source: ModelDefaultWriteSource
): StructuredAgentSessionMutate {
  const {
    controller,
    activeOptionRecordRef,
    isCurrentContext,
    updateOptionState,
    optionPicks,
    writes,
    beginOptionWrite
  } = source
  return useCallback(
    <T>(...args: Parameters<StructuredAgentSessionMutate>) =>
      writeStructuredAgentSessionModelDefault<T>(
        {
          mutate,
          controller,
          activeOptionRecordRef,
          isCurrentContext,
          updateOptionState,
          optionPicks,
          writes,
          beginOptionWrite
        },
        args
      ),
    [
      activeOptionRecordRef,
      beginOptionWrite,
      controller,
      isCurrentContext,
      mutate,
      optionPicks,
      updateOptionState,
      writes
    ]
  )
}
