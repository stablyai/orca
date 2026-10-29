import { structuredLaunchRequestedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { useCallback } from 'react'
import { structuredAgentSessionSendSelection } from '../../../../shared/structured-agent-session-option-view'
import { getStructuredAgentSessionLaunchSelection } from '@/lib/structured-agent-session-launch-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'

/** What each send carries to a host that takes it: the chat's own model and effort, picks over them. */
export function useStructuredAgentSessionSendOptions(
  sessionId: string,
  launch: StructuredAgentSessionLaunchView | undefined,
  source: Pick<
    ReturnType<typeof useStructuredAgentSessionOptionState>,
    'optionStateRef' | 'optionPicks' | 'optionView' | 'takesSendOptions'
  >
): () => Readonly<Record<string, string>> | undefined {
  const { optionStateRef, optionView, optionPicks, takesSendOptions } = source
  return useCallback(() => {
    if (!takesSendOptions) {
      return undefined
    }
    // Read held picks directly because launch acceptance can precede this render’s props.
    const selection = getStructuredAgentSessionLaunchSelection(sessionId)
    const requested = structuredLaunchRequestedOptions({
      seed: selection?.seed ?? launch?.seedOptions,
      explicit: selection?.explicit ?? launch?.explicitOptions,
      held: { ...(selection?.held ?? launch?.heldOptions), ...optionPicks.current.pending }
    })
    if (requested?.model !== undefined) {
      return requested
    }
    // A pick on its way resolves as the picker shows it, keeping the model it names.
    const view = optionView(optionStateRef.current, selection?.seed ?? launch?.seedOptions, {
      ...(selection?.held ?? launch?.heldOptions),
      ...optionPicks.current.pending
    })
    return structuredAgentSessionSendSelection(view)
  }, [launch, optionStateRef, optionView, optionPicks, sessionId, takesSendOptions])
}
