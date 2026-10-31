import { useNativeChatChildHistory } from './use-native-chat-child-history'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentType, NativeChatSubagentEntry } from '../../../../shared/native-chat-types'
import type { OrchestrationSessionChild } from '../../../../shared/orchestration-session-children'
import type { NativeChatChildTranscriptProps } from './NativeChatChildTranscript'
import { NativeChatChildTranscriptFrame } from './NativeChatChildTranscriptFrame'
import {
  NativeChatChildNavigationContext,
  useNativeChatChildNavigation,
  type NativeChatChildLocation
} from './native-chat-child-navigation'
import { NativeChatWorkerScope, useNativeChatWorkerScope } from './native-chat-worker-scope'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'
import { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { nativeChatChildTranscript } from './native-chat-child-transcript'

export function NativeChatStructuredChildTranscript(
  props: NativeChatChildTranscriptProps
): React.JSX.Element {
  useTranslation()
  const source = props.child.source
  const scope = useNativeChatWorkerScope()
  if (source?.kind === 'worker') {
    return scope?.source === source ? (
      <WorkerTranscript {...props} source={source} workerRoster={scope.roster} />
    ) : (
      <NativeChatWorkerScope source={source} isVisible={props.isVisible}>
        {(roster) => <WorkerTranscript {...props} source={source} workerRoster={roster} />}
      </NativeChatWorkerScope>
    )
  }
  return source?.kind === 'journal' ? (
    scope ? (
      <WorkerTranscript
        {...props}
        source={scope.source}
        workerRoster={scope.roster}
        journalSource={source}
        scopeAgentId={props.child.agentId}
      />
    ) : (
      <JournalTranscript {...props} source={source} scopeAgentId={props.child.agentId} />
    )
  ) : (
    <NativeChatChildTranscriptFrame {...props} />
  )
}

function WorkerTranscript({
  source,
  journalSource,
  scopeAgentId,
  workerRoster: roster,
  ...props
}: NativeChatChildTranscriptProps & {
  workerRoster: NonNullable<ReturnType<typeof useNativeChatWorkerScope>>['roster']
  source: Extract<
    NonNullable<NativeChatChildTranscriptProps['child']['source']>,
    { kind: 'worker' }
  >
  journalSource?: Extract<
    NonNullable<NativeChatChildTranscriptProps['child']['source']>,
    { kind: 'journal' }
  >
  scopeAgentId?: string
}): React.JSX.Element {
  const worker = roster.children.find((child) => child.dispatchId === source.dispatchId)
  const recorded = worker?.conversation
  const conversation =
    journalSource &&
    recorded?.kind === 'journal' &&
    (recorded.sessionId !== journalSource.sessionId || recorded.agent !== journalSource.agent)
      ? undefined
      : (recorded ?? (!roster.current ? journalSource : undefined))
  if (conversation?.kind === 'journal') {
    return (
      <JournalTranscript
        key={`${conversation.sessionId}:${conversation.agent}`}
        {...props}
        worker={journalSource ? undefined : worker}
        workerCurrent={roster.current}
        scopeAgentId={scopeAgentId}
        source={{ ...conversation, target: source.target }}
      />
    )
  }
  const session: NativeChatLiveSession = {
    ...props.session,
    sessionId: null,
    messages: [],
    status: roster.loading ? 'loading' : 'error',
    readPhase: roster.loading ? 'loading' : 'error',
    readCurrent: false,
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: async () => 'exhausted'
  }
  return (
    <NativeChatChildTranscriptFrame
      {...props}
      session={session}
      onLinkClick={undefined}
      runtimeContext={undefined}
      roster={undefined}
      worker={journalSource ? undefined : worker}
      entry={journalSource ? undefined : workerEntry(worker)}
      unavailable={roster.loading ? undefined : unavailableText(conversation)}
    />
  )
}

function workerEntry(
  worker: OrchestrationSessionChild | undefined
): NativeChatSubagentEntry | undefined {
  return worker
    ? {
        id: `dispatch:${worker.dispatchId}`,
        label: worker.label,
        state: worker.state,
        startedAt: worker.startedAt,
        ...(worker.settledAt === undefined ? {} : { settledAt: worker.settledAt })
      }
    : undefined
}

function unavailableText(
  conversation: OrchestrationSessionChild['conversation'] | undefined
): string {
  if (conversation?.kind === 'unavailable' && conversation.reason === 'identity-unverifiable') {
    return translate(
      'components.native-chat.children.identityUnavailable',
      'This worker’s conversation identity could not be verified.'
    )
  }
  if (conversation?.kind === 'unavailable' && conversation.reason === 'terminal-worker') {
    return translate(
      'components.native-chat.children.terminalUnavailable',
      'This worker runs in a terminal. Its conversation history is unavailable here.'
    )
  }
  if (conversation?.kind === 'unavailable' && conversation.reason === 'remote-worker') {
    return translate(
      'components.native-chat.children.remoteUnavailable',
      'This worker’s execution host has not supplied an inspectable conversation.'
    )
  }
  return translate(
    'components.native-chat.children.unavailable',
    'This host has not supplied the agent’s conversation history.'
  )
}

function JournalTranscript({
  source,
  scopeAgentId,
  workerCurrent = true,
  ...props
}: NativeChatChildTranscriptProps & {
  source: { target: RuntimeClientTarget; sessionId: string; agent: AgentType; workspaceId?: string }
  scopeAgentId?: string
  workerCurrent?: boolean
}): React.JSX.Element {
  const navigation = useNativeChatChildNavigation()
  const read = useStructuredAgentSessionRead({
    target: source.target,
    sessionId: source.sessionId,
    isVisible: props.isVisible,
    isViewed: false
  })
  const presentation = useStructuredAgentSessionTransportState(read.state, true)
  const projected = useStructuredAgentSessionMessages(
    read.state.items,
    NO_OPTIMISTIC,
    read.state.submissions
  )
  useNativeChatChildHistory({
    scopeKey: JSON.stringify([source.target, source.sessionId, scopeAgentId]),
    agentId: scopeAgentId,
    messages: projected,
    hasMore: read.state.hasOlder,
    loading: read.loadingOlder,
    generation: read.olderHistoryGeneration,
    anchorKey: read.state.items[0]?.itemId,
    enabled:
      (source.agent === 'codex' || source.agent === 'claude') &&
      props.isVisible &&
      props.active !== false,
    loadEarlier: read.loadOlder
  })
  const messages = useMemo(
    () => (scopeAgentId ? nativeChatChildTranscript(projected, scopeAgentId) : projected),
    [projected, scopeAgentId]
  )
  const entry = scopeAgentId
    ? read.state.subagentRoster?.get(scopeAgentId)?.entry
    : workerEntry(props.worker)
  const session = useMemo<NativeChatLiveSession>(
    () => ({
      sessionId: source.sessionId,
      agent: source.agent,
      messages,
      status:
        read.state.status === 'error'
          ? 'error'
          : read.state.status !== 'ready'
            ? 'loading'
            : workerCurrent && read.readCurrent && presentation.isWorking
              ? 'working'
              : messages.length
                ? 'ready'
                : 'empty',
      readPhase:
        read.state.status === 'error'
          ? 'error'
          : read.state.status !== 'ready'
            ? 'loading'
            : 'ready',
      readCurrent: workerCurrent && read.readCurrent,
      hasMore: read.state.hasOlder,
      loadingEarlier: read.loadingOlder,
      olderHistoryGeneration: read.olderHistoryGeneration,
      loadEarlier: read.loadOlder
    }),
    [source.sessionId, source.agent, messages, read, presentation.isWorking, workerCurrent]
  )
  const runtimeContext = useMemo<RuntimeFileOperationArgs>(
    () => ({
      target: source.target,
      worktreeId: source.workspaceId,
      worktreePath: undefined
    }),
    [source.target, source.workspaceId]
  )
  const sameFileScope =
    source.workspaceId === props.runtimeContext?.worktreeId &&
    JSON.stringify(source.target) === JSON.stringify(props.runtimeContext?.target)
  const childNavigation = useMemo(
    () => ({
      open: (child: NativeChatChildLocation) =>
        navigation?.open({
          ...child,
          source: child.source ?? { kind: 'journal', ...source }
        })
    }),
    [navigation, source]
  )
  return (
    <NativeChatChildNavigationContext.Provider value={childNavigation}>
      <NativeChatChildTranscriptFrame
        {...props}
        session={session}
        entry={entry}
        roster={read.state.subagentRoster}
        journal={scopeAgentId ? undefined : read.state}
        presentation={scopeAgentId ? undefined : presentation}
        runtimeContext={runtimeContext}
        onLinkClick={sameFileScope ? props.onLinkClick : undefined}
        workerTarget={scopeAgentId ? undefined : source.target}
        unavailable={
          !workerCurrent
            ? messages.length > 0
              ? translate(
                  'components.native-chat.children.retainedUnavailable',
                  'The worker’s identity could not be verified. Showing retained history.'
                )
              : unavailableText({ kind: 'unavailable', reason: 'identity-unverifiable' })
            : read.state.status === 'error' || (read.state.epoch !== null && !read.readCurrent)
              ? unavailableText(undefined)
              : undefined
        }
      />
    </NativeChatChildNavigationContext.Provider>
  )
}

const NO_OPTIMISTIC = [] as const
