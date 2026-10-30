import type {
  SelectionOperation,
  SelectionOutcome
} from '../../../shared/structured-agent-session-selection-operations'
import type { AgentSessionWriteFailure } from '../../../shared/agent-session-write-failure'
import {
  STRUCTURED_LAUNCH_OPTION_IDS,
  structuredLaunchCompatibleOptions,
  structuredLaunchRequestedOptions
} from '../../../shared/native-chat/input/native-chat-session-option-defaults'
import type { structuredSessionSelectionController } from './structured-agent-session-selection-controller'
import type { StructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-registry'
import { StructuredAgentSessionLaunchCancelledError } from './agent-session/launch/structured-agent-session-launch-recovery'

export type LegacyPrerequisites = {
  intent: StructuredLaunchState['intent']
  decision: Promise<AgentSessionWriteFailure | undefined>
  advance?: () => void
}

export function createLegacyPrerequisites(
  state: StructuredLaunchState,
  controller: ReturnType<typeof structuredSessionSelectionController>,
  send: (key: string, value: string) => Promise<SelectionOutcome>,
  handoff: () => void
): LegacyPrerequisites {
  const result = Promise.withResolvers<AgentSessionWriteFailure | undefined>()
  const active: LegacyPrerequisites = { intent: state.intent, decision: result.promise }
  const explicit = state.selection.explicit
  const context = new Map<string, SelectionOperation>()
  const direct = new Set<string>()
  const enrolled = new Set<SelectionOperation>()
  let pending = 0
  let release = () => {}
  const finish = (failure?: AgentSessionWriteFailure, error?: unknown) => {
    if (!active.advance) {
      return
    }
    active.advance = undefined
    release()
    context.clear()
    enrolled.clear()
    if (error !== undefined) {
      result.reject(error)
    } else {
      // Remaining picker work has its own result and must not delay failed action handback.
      if (failure) {
        handoff()
      }
      result.resolve(failure)
    }
  }
  const perform = (key: string, value: string) => {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    return send(key, value)
  }
  const enroll = (
    key: string,
    value: string,
    required: boolean,
    operation?: SelectionOperation
  ) => {
    pending++
    if (operation) {
      enrolled.add(operation)
    }
    const request = operation
      ? controller.transmit(operation, () => perform(key, value))
      : (async () => perform(key, value))()
    void request.then(
      (outcome) => {
        pending--
        if (!active.advance) {
          return
        }
        if (!controller.isCurrent()) {
          finish(undefined, new Error('Conversation selection owner retired.'))
        } else if (
          required &&
          (outcome.kind === 'refused' || outcome.kind === 'unknown') &&
          outcome.failure
        ) {
          finish(outcome.failure)
        } else {
          active.advance()
        }
      },
      (error: unknown) => finish(undefined, error)
    )
  }
  active.advance = () => {
    if (!controller.isCurrent() || state.cancelled) {
      finish(
        undefined,
        state.cancelled
          ? new StructuredAgentSessionLaunchCancelledError()
          : new Error('Conversation selection owner retired.')
      )
      return
    }
    for (const key of STRUCTURED_LAUNCH_OPTION_IDS) {
      const operation = controller.current(key)
      if (operation) {
        context.set(key, operation)
      }
    }
    const held = Object.fromEntries([...context].map(([key, operation]) => [key, operation.value]))
    const requested = structuredLaunchRequestedOptions({ explicit, held })
    const compatible = requested && structuredLaunchCompatibleOptions(state.intent.agent, requested)
    for (const key of STRUCTURED_LAUNCH_OPTION_IDS) {
      const operation = context.get(key)
      if (operation && !operation.outcome && !enrolled.has(operation)) {
        enroll(key, operation.value, requested?.[key] !== undefined, operation)
      }
      const value = compatible?.[key]
      if (value !== undefined && !context.has(key) && !direct.has(key) && key !== 'fastMode') {
        if (!pending) {
          direct.add(key)
          enroll(key, value, requested?.[key] !== undefined)
        }
        return
      }
    }
    if (pending) {
      return
    }
    finish()
  }
  release = controller.subscribe(() => {
    if (!controller.isCurrent()) {
      active.advance?.()
    }
  })
  return active
}
