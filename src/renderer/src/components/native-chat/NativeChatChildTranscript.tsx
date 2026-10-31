import { useNativeChatChildHistory } from './use-native-chat-child-history'
import { Fragment, useMemo } from 'react'
import { NativeChatWorkerScope } from './native-chat-worker-scope'
import type { OrchestrationSessionChild } from '../../../../shared/orchestration-session-children'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import type { NativeChatChildLocation } from './native-chat-child-navigation'
import { nativeChatChildLocationKey } from './native-chat-child-navigation'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import { nativeChatChildTranscript } from './native-chat-child-transcript'
import { NativeChatChildTranscriptFrame } from './NativeChatChildTranscriptFrame'
import { NativeChatStructuredChildTranscript } from './NativeChatStructuredChildTranscript'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'

export type NativeChatChildTranscriptProps = {
  child: NativeChatChildLocation
  parent: NativeChatChildLocation | null
  onBack: () => void
  session: NativeChatLiveSession
  roster?: StructuredAgentSubagentRoster
  isVisible: boolean
  onLinkClick?: CommentMarkdownLinkClickHandler
  runtimeContext?: RuntimeFileOperationArgs | null
  messageListRef?: React.Ref<NativeChatMessageListHandle>
  active?: boolean
  worker?: OrchestrationSessionChild
}

export function NativeChatChildTranscript(
  props: NativeChatChildTranscriptProps
): React.JSX.Element {
  return props.child.source ? (
    <NativeChatStructuredChildTranscript {...props} />
  ) : (
    <ProviderChildTranscript {...props} />
  )
}

function ProviderChildTranscript(props: NativeChatChildTranscriptProps): React.JSX.Element {
  const { child, session, roster } = props
  useNativeChatChildHistory({
    scopeKey: `${session.sessionId ?? ''}:${child.agentId}`,
    agentId: child.agentId,
    messages: session.messages,
    hasMore: session.hasMore,
    loading: session.loadingEarlier,
    generation: session.olderHistoryGeneration,
    enabled:
      (session.agent === 'codex' || session.agent === 'claude') &&
      props.isVisible &&
      props.active !== false,
    loadEarlier: session.loadEarlier
  })
  const messages = useMemo(
    () => nativeChatChildTranscript(session.messages, child.agentId),
    [session.messages, child.agentId]
  )
  const entry = roster?.get(child.agentId)?.entry
  const working = entry?.state === 'working' && session.readCurrent !== false
  const childSession = useMemo<NativeChatLiveSession>(
    () => ({
      ...session,
      sessionId: `${session.sessionId ?? ''}:child:${child.agentId}`,
      messages,
      status: working ? 'working' : messages.length > 0 ? 'ready' : 'empty',
      transcriptLifecycle: undefined,
      hookAwaitingInput: false
    }),
    [session, child.agentId, messages, working]
  )
  return <NativeChatChildTranscriptFrame {...props} session={childSession} entry={entry} />
}

export function NativeChatChildTranscriptStack({
  path,
  messageListRef,
  ...props
}: Omit<NativeChatChildTranscriptProps, 'child' | 'parent' | 'active'> & {
  path: readonly NativeChatChildLocation[]
}): React.JSX.Element {
  const renderLevel = (index: number): React.ReactNode => {
    const child = path[index]
    if (!child) {
      return null
    }
    const content = () => (
      <>
        <NativeChatChildTranscript
          {...props}
          child={child}
          parent={path[index - 1] ?? null}
          active={index === path.length - 1}
          messageListRef={index === path.length - 1 ? messageListRef : undefined}
        />
        {renderLevel(index + 1)}
      </>
    )
    const key = nativeChatChildLocationKey(child)
    return child.source?.kind === 'worker' ? (
      <NativeChatWorkerScope key={key} source={child.source} isVisible={props.isVisible}>
        {content}
      </NativeChatWorkerScope>
    ) : (
      <Fragment key={key}>{content()}</Fragment>
    )
  }
  return <>{renderLevel(0)}</>
}
