import { useCallback, useEffect, useMemo } from 'react'
import { getConsentState } from '@/lib/telemetry'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { UseNativeChatLiveSessionArgs } from './session/terminal/read/native-chat-live-session-contract'
import type { StructuredAgentSessionState } from '../../../../shared/agent-session/structured-agent-session-reducer'

export type NativeChatSubmissionSource = {
  key: string
  readPriorSubmission: (signal?: AbortSignal) => Promise<boolean>
}

export function structuredChatSubmissionSource(
  args: { target: RuntimeClientTarget; sessionId: string },
  state: Pick<StructuredAgentSessionState, 'epoch' | 'items' | 'hasOlder'>,
  enabled: boolean
): NativeChatSubmissionSource {
  return {
    key: JSON.stringify([args.target, args.sessionId, state.epoch]),
    readPriorSubmission: (signal) =>
      readStructuredChatPriorSubmission({
        ...args,
        signal,
        before:
          enabled && state.hasOlder && state.epoch && state.items[0]
            ? { epoch: state.epoch, sequence: state.items[0].sequence }
            : null
      })
  }
}

export function ptyChatSubmissionSource(
  args: UseNativeChatLiveSessionArgs,
  messages: readonly NativeChatMessage[],
  hasMore: boolean
): NativeChatSubmissionSource {
  return {
    key: JSON.stringify([
      args.paneKey,
      args.runtimeEnvironmentId ?? null,
      args.agent,
      args.sessionId,
      args.transcriptPath ?? null
    ]),
    readPriorSubmission: (signal) =>
      args.sessionId && hasMore
        ? readPtyChatPriorSubmission({
            target: args.runtimeEnvironmentId
              ? { kind: 'environment', environmentId: args.runtimeEnvironmentId }
              : { kind: 'local' },
            agent: args.agent,
            sessionId: args.sessionId,
            transcriptPath: args.transcriptPath,
            messages,
            signal
          })
        : Promise.resolve(false)
  }
}

const SUBMISSION_HISTORY_TIMEOUT_MS = 5_000

export function useNativeChatSubmissionHistory(key: string): {
  submissionHistory: Map<string, Promise<boolean>>
  readPriorSubmission: (source: NativeChatSubmissionSource | undefined) => Promise<boolean>
} {
  const state = useMemo<{
    key: string
    submissionHistory: Map<string, Promise<boolean>>
    controller: AbortController
    priorSubmission?: Promise<boolean>
  }>(
    () => ({
      key,
      submissionHistory: new Map<string, Promise<boolean>>(),
      controller: new AbortController()
    }),
    [key]
  )
  useEffect(() => {
    if (state.controller.signal.aborted) {
      state.controller = new AbortController()
      state.priorSubmission = undefined
    }
    const { controller } = state
    return () => controller.abort()
  }, [state])
  const readPriorSubmission = useCallback(
    (source: NativeChatSubmissionSource | undefined) => {
      if (!source || state.controller.signal.aborted) {
        return Promise.resolve(false)
      }
      state.priorSubmission ??= source
        .readPriorSubmission(state.controller.signal)
        .catch(() => false)
      return state.priorSubmission
    },
    [state]
  )
  return { submissionHistory: state.submissionHistory, readPriorSubmission }
}

function submissionHistorySignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(SUBMISSION_HISTORY_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

async function canReadSubmissionHistory(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return false
  }
  const consent = await waitForPromiseWithSignal(getConsentState(), signal)
  return !signal.aborted && consent.effective === 'enabled'
}

/** Read older evidence without moving the displayed history or including the send being measured. */
export async function readStructuredChatPriorSubmission(args: {
  target: RuntimeClientTarget
  sessionId: string
  before: AgentJournalCursor | null
  signal?: AbortSignal
}): Promise<boolean> {
  if (!args.before) {
    return false
  }
  const signal = submissionHistorySignal(args.signal)
  if (!(await canReadSubmissionHistory(signal))) {
    return false
  }
  const result = await callRuntimeRpc<{ hasPriorSubmission: boolean }>(
    args.target,
    'agentSession.submissionSummary',
    { sessionId: args.sessionId, before: args.before },
    { signal, suppressFeatureInteraction: true }
  )
  return !signal.aborted && result.hasPriorSubmission
}

export async function readPtyChatPriorSubmission(args: {
  target: RuntimeClientTarget
  agent: AgentType
  sessionId: string
  transcriptPath?: string | null
  messages: readonly NativeChatMessage[]
  signal?: AbortSignal
}): Promise<boolean> {
  const anchor = args.messages.at(-1)?.id
  if (!anchor) {
    return false
  }
  const signal = submissionHistorySignal(args.signal)
  if (!(await canReadSubmissionHistory(signal))) {
    return false
  }
  const result = await callRuntimeRpc<{ hasPriorSubmission: boolean }>(
    args.target,
    'nativeChat.submissionSummary',
    {
      agent: args.agent,
      sessionId: args.sessionId,
      transcriptPath: args.transcriptPath ?? undefined,
      anchorId: anchor
    },
    { signal, suppressFeatureInteraction: true }
  )
  return !signal.aborted && result.hasPriorSubmission
}
