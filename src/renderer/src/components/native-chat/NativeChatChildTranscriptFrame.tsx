import { NativeChatChildMediaScope } from './NativeChatChildMediaScope'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Bot, Loader2 } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { NativeChatSubagentEntry } from '../../../../shared/native-chat-types'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import { normalizeSubagentState } from '../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import { subagentStateLabel } from '../../../../shared/native-chat/transcript/native-chat-subagent-group-header'
import { sayNativeChatSubagentGroupTranslated as say } from './native-chat-subagent-group-words-text'
import { NativeChatMessageList } from './NativeChatMessageList'
import { StatusDot } from './NativeChatSubagentRun'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import type { NativeChatChildTranscriptProps } from './NativeChatChildTranscript'
import { nativeChatWorkerStateLabel, NativeChatSessionChildren } from './NativeChatSessionChildren'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'
import { NativeChatChildMetadata } from './NativeChatChildMetadata'

export function NativeChatChildTranscriptFrame({
  child,
  parent,
  onBack,
  session,
  roster,
  isVisible,
  onLinkClick,
  runtimeContext,
  messageListRef,
  active = true,
  entry,
  worker,
  journal,
  unavailable,
  workerTarget,
  presentation
}: NativeChatChildTranscriptProps & {
  entry?: NativeChatSubagentEntry
  journal?: StructuredAgentSessionState
  unavailable?: string
  workerTarget?: RuntimeClientTarget
  presentation?: ReturnType<typeof useStructuredAgentSessionTransportState>
}): React.JSX.Element {
  useTranslation()
  const state = entry ? normalizeSubagentState(entry.state) : null
  const working = (presentation?.isWorking ?? state === 'working') && session.readCurrent !== false
  const dateFormat = new Intl.DateTimeFormat(getIntlLocale(), {
    dateStyle: 'short',
    timeStyle: 'short'
  })
  return (
    <NativeChatChildMediaScope
      target={unavailable ? undefined : workerTarget}
      runtimeContext={runtimeContext}
      sessionId={session.sessionId}
      isVisible={isVisible && active}
    >
      <section
        aria-label={child.label}
        data-native-chat-child-transcript={child.agentId}
        data-native-chat-inherit-link-context={onLinkClick !== undefined ? 'true' : 'false'}
        hidden={!active}
        inert={!active}
        className={active ? 'flex min-h-0 flex-1 flex-col bg-chat-canvas' : 'hidden'}
      >
        <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            <span className="max-w-48 truncate">
              {parent?.label ??
                translate('components.native-chat.children.back', 'Back to conversation')}
            </span>
          </Button>
          <Bot aria-hidden="true" className="size-4 shrink-0 text-chat-foreground-faint" />
          <span className="min-w-0 truncate text-sm font-medium text-chat-foreground-strong">
            {entry?.label ?? child.label}
          </span>
          {state ? (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-chat-foreground-faint">
              <StatusDot state={state} pulsing={working} />
              {worker ? nativeChatWorkerStateLabel(worker) : subagentStateLabel(state, 1, 1, say)}
            </span>
          ) : null}
        </header>
        {worker ? (
          <NativeChatChildMetadata
            worker={worker}
            target={workerTarget ?? child.source?.target}
            detailed
          />
        ) : null}
        {entry?.startedAt !== undefined || entry?.settledAt !== undefined ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-xs text-chat-foreground-faint">
            {entry.startedAt !== undefined ? (
              <time dateTime={new Date(entry.startedAt).toISOString()}>
                {translate('components.native-chat.children.started', 'Started {{value0}}', {
                  value0: dateFormat.format(entry.startedAt)
                })}
              </time>
            ) : null}
            {entry.settledAt !== undefined ? (
              <time dateTime={new Date(entry.settledAt).toISOString()}>
                {translate('components.native-chat.children.finished', 'Finished {{value0}}', {
                  value0: dateFormat.format(entry.settledAt)
                })}
              </time>
            ) : null}
          </div>
        ) : null}
        {workerTarget && session.sessionId ? (
          <NativeChatSessionChildren
            sessionId={session.sessionId}
            target={workerTarget}
            dispatchId={worker?.dispatchId}
            isVisible={isVisible && active}
          />
        ) : null}
        {unavailable ? (
          <p role="status" className="px-4 py-2 text-sm text-chat-foreground-faint">
            {unavailable}
          </p>
        ) : null}
        {session.messages.length > 0 ? (
          <NativeChatRewindContext.Provider value={undefined}>
            <NativeChatMessageList
              ref={messageListRef}
              session={session}
              subagentRoster={roster}
              journalItems={journal?.items}
              journalSubmissions={journal?.submissions}
              journalLatestTurn={journal?.latestTurn}
              journalHostWork={presentation?.hostWork}
              isVisible={isVisible && active}
              isWorking={working}
              workingStartedAt={presentation?.turnTiming.workingStartedAt ?? entry?.startedAt}
              settledTurns={presentation?.turnTiming.settledTurns}
              turnActivity={presentation?.turnActivity}
              expandSignal={false}
              onLinkClick={onLinkClick}
              allowFileUriLinks={onLinkClick !== undefined}
              runtimeContext={runtimeContext}
            />
          </NativeChatRewindContext.Provider>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-chat-foreground-faint">
            {!unavailable ? (
              <p>
                {session.readPhase === 'loading' || session.loadingEarlier
                  ? translate('components.native-chat.children.loading', 'Loading agent history…')
                  : translate(
                      'components.native-chat.children.unavailable',
                      'This host has not supplied the agent’s conversation history.'
                    )}
              </p>
            ) : null}
            {session.hasMore ? (
              <Button
                variant="outline"
                size="sm"
                disabled={session.loadingEarlier}
                onClick={() => void session.loadEarlier()}
              >
                {session.loadingEarlier ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : null}
                {translate('components.native-chat.children.loadEarlier', 'Load earlier history')}
              </Button>
            ) : null}
          </div>
        )}
        {worker?.result ? (
          <div className="scrollbar-sleek max-h-40 shrink-0 overflow-y-auto border-t border-border px-4 py-2">
            <Collapsible
              defaultOpen={session.messages.length === 0 && session.readPhase === 'error'}
            >
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm">
                  {translate('components.native-chat.children.result', 'Recorded result')}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CommentMarkdown
                  content={worker.result}
                  onLinkClick={onLinkClick}
                  allowFileUriLinks={onLinkClick !== undefined}
                  className="py-2 text-sm text-chat-foreground"
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        ) : null}
      </section>
    </NativeChatChildMediaScope>
  )
}
