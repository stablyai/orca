import { useCallback, useEffect, useMemo } from 'react'
import { getConsentState } from '@/diagnostics/telemetry/telemetry'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { UseNativeChatLiveSessionArgs } from './session/terminal/read/native-chat-live-session-contract'
import type { StructuredAgentSessionState } from '../../../../shared/agent-session/structured-agent-session-reducer'
import { getStructuredAgentSessionReadOwner } from './session/structured/read/structured-agent-session-read-owner'
import { readNativeChatStructuredSubmissionDelivery } from './telemetry/native-chat-structured-submission-delivery'

export type NativeChatSubmissionSource = {
  key: string
  readPriorSubmission: (signal?: AbortSignal) => Promise<boolean>
  readDelivery?: (clientMessageId: string, signal: AbortSignal) => Promise<boolean>
}

export function structuredChatSubmissionSource(
  args: { target: RuntimeClientTarget; sessionId: string },
  state: Pick<StructuredAgentSessionState, 'epoch' | 'items' | 'hasOlder'>,
  enabled: boolean
): NativeChatSubmissionSource {
  return {
    key: JSON.stringify([args.target, args.sessionId, state.epoch]),
    readDelivery: (clientMessageId, signal) =>
      readNativeChatStructuredSubmissionDelivery(
        getStructuredAgentSessionReadOwner(args.sessionId, args.target),
        clientMessageId,
        signal
      ),
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

function createSubmissionHistory(key: string) {
  let controller = new AbortController()
  let priorSubmission: Promise<boolean> | undefined
  return {
    key,
    submissionHistory: new Map<string, Promise<boolean>>(),
    start: () => {
      if (controller.signal.aborted) {
        controller = new AbortController()
        priorSubmission = undefined
      }
      const activeController = controller
      return () => activeController.abort()
    },
    read: (source: NativeChatSubmissionSource | undefined) => {
      if (!source || controller.signal.aborted) {
        return Promise.resolve(false)
      }
      if (!priorSubmission) {
        priorSubmission = source.readPriorSubmission(controller.signal).catch(() => false)
      }
      return priorSubmission
    },
    readDelivery: (
      source: NativeChatSubmissionSource | undefined,
      clientMessageId: string,
      signal: AbortSignal
    ) => {
      if (!source?.readDelivery || controller.signal.aborted) {
        return Promise.resolve(false)
      }
      return source
        .readDelivery(clientMessageId, AbortSignal.any([signal, controller.signal]))
        .catch(() => false)
    }
  }
}

export function useNativeChatSubmissionHistory(key: string): {
  submissionHistory: Map<string, Promise<boolean>>
  readPriorSubmission: (source: NativeChatSubmissionSource | undefined) => Promise<boolean>
  readSubmissionDelivery: (
    source: NativeChatSubmissionSource | undefined,
    clientMessageId: string,
    signal: AbortSignal
  ) => Promise<boolean>
} {
  const state = useMemo(() => createSubmissionHistory(key), [key])
  useEffect(() => state.start(), [state])
  const readPriorSubmission = useCallback(
    (source: NativeChatSubmissionSource | undefined) => state.read(source),
    [state]
  )
  const readSubmissionDelivery = useCallback(
    (
      source: NativeChatSubmissionSource | undefined,
      clientMessageId: string,
      signal: AbortSignal
    ) => state.readDelivery(source, clientMessageId, signal),
    [state]
  )
  return { submissionHistory: state.submissionHistory, readPriorSubmission, readSubmissionDelivery }
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
