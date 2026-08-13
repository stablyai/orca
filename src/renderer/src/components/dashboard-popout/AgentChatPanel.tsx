import { useId, useMemo } from 'react'
import { SquareTerminal, XIcon } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { NativeChatConversation } from '@/components/native-chat/NativeChatConversation'
import type { NativeChatConversationLiveState } from '@/components/native-chat/native-chat-conversation-types'
import type { NativeChatPtyWriter } from '@/components/native-chat/native-chat-pty-writer'
import type { NativeChatAttachmentOwner } from '@/components/native-chat/native-chat-attachment-upload'
import { isAskUserQuestionTool } from '../../../../shared/agent-question-answered-intent'
import { translate } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import {
  dashboardCardDisplayState,
  type DashboardCard
} from '../../../../shared/dashboard-snapshot'
import { resolveAgentChatPanelMode, type AgentChatPanelMode } from './agent-chat-panel-mode'

type AgentChatPanelProps = {
  card: DashboardCard
  onClose: () => void
  onOpenTerminal?: () => void
  ptyWriter?: NativeChatPtyWriter
  className?: string
}

const LOCAL_ATTACHMENT_OWNER: NativeChatAttachmentOwner = { kind: 'local' }

function conversationLiveState(card: DashboardCard): NativeChatConversationLiveState {
  const questionInferenceRequest =
    card.agentType === 'claude' &&
    isAskUserQuestionTool(card.interactiveToolName) &&
    card.statusUpdatedAt !== undefined &&
    card.lastUserMessage !== undefined
      ? {
          paneKey: card.paneKey,
          baselineUpdatedAt: card.statusUpdatedAt,
          baselineStateStartedAt: card.stateChangedAt,
          baselinePrompt: card.lastUserMessage,
          baselineAgentType: card.agentType
        }
      : undefined
  return {
    working: card.bucket === 'working',
    stateStartedAt: card.stateChangedAt || null,
    lastAssistantMessage: card.lastAgentMessage ?? null,
    interactivePrompt: card.askSummary ?? null,
    interactiveToolName: card.interactiveToolName ?? null,
    ...(questionInferenceRequest ? { questionInferenceRequest } : {})
  }
}

function agentName(card: DashboardCard): string {
  return card.conversationName ?? (card.task.trim() || formatAgentTypeLabel(card.agentType))
}

function AgentChatFallback({
  card,
  reason
}: {
  card: DashboardCard
  reason: 'no-session' | 'remote-host'
}): React.JSX.Element {
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
      <p className="text-xs text-muted-foreground">
        {reason === 'remote-host'
          ? translate(
              'dashboardPopout.chat.remoteHost',
              "This agent's transcript is on another host, so it is not readable here."
            )
          : translate(
              'dashboardPopout.chat.noSession',
              'This agent has not reported a session yet, so there is no transcript to read.'
            )}
      </p>
      {card.askSummary ? (
        <section className="rounded-lg border border-border bg-muted/40 p-3">
          <h3 className="mb-1 text-[11px] font-semibold text-muted-foreground">
            {translate('dashboardPopout.chat.pendingQuestion', 'Pending question')}
          </h3>
          <p className="text-xs whitespace-pre-wrap">{card.askSummary}</p>
        </section>
      ) : null}
      {card.lastAgentMessage ? (
        <section className="rounded-lg border border-border p-3">
          <h3 className="mb-1 text-[11px] font-semibold text-muted-foreground">
            {translate('dashboardPopout.chat.lastMessage', 'Last message')}
          </h3>
          <p className="text-xs whitespace-pre-wrap">{card.lastAgentMessage}</p>
        </section>
      ) : null}
    </div>
  )
}

function AgentChatBody({
  card,
  mode,
  onSwitchToTerminal,
  ptyWriter
}: {
  card: DashboardCard
  mode: AgentChatPanelMode
  onSwitchToTerminal?: () => void
  ptyWriter?: NativeChatPtyWriter
}): React.JSX.Element {
  const liveState = useMemo(() => conversationLiveState(card), [card])
  if (mode.kind === 'degraded') {
    return <AgentChatFallback card={card} reason={mode.reason} />
  }
  return (
    <NativeChatConversation
      key={`${card.paneKey}:${mode.sessionId}`}
      paneKey={card.paneKey}
      agent={card.agentType}
      sessionId={mode.sessionId}
      transcriptPath={mode.transcriptPath}
      targetPtyId={card.ptyId}
      terminalTabId={card.tabId}
      onSwitchToTerminal={onSwitchToTerminal}
      ptyWriter={ptyWriter}
      attachmentOwner={LOCAL_ATTACHMENT_OWNER}
      dictationEnabled={false}
      sessionOptionsEnabled={false}
      fileDropEnabled={false}
      fileLinksEnabled={false}
      liveState={liveState}
    />
  )
}

/** Native chat transcript and reply surface for a dashboard agent. */
export function AgentChatPanel({
  card,
  onClose,
  onOpenTerminal,
  ptyWriter,
  className
}: AgentChatPanelProps): React.JSX.Element {
  const titleId = useId()
  const mode = resolveAgentChatPanelMode(card)

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'm-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border',
        'bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]',
        className
      )}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2.5">
        <AgentStateDot state={dashboardCardDisplayState(card)} size="md" className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-[12px] leading-normal font-semibold">
            {agentName(card)}
          </h2>
          <span className="block truncate text-[11px] text-muted-foreground">
            {card.repoName} / {card.worktreeName}
          </span>
        </span>
        {onOpenTerminal ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 gap-1.5"
            onClick={onOpenTerminal}
          >
            <SquareTerminal className="size-3.5" />
            {translate('dashboardPopout.chat.openTerminal', 'Open terminal')}
          </Button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label={translate('dashboardPopout.chat.close', 'Close chat')}
          className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <AgentChatBody
        card={card}
        mode={mode}
        onSwitchToTerminal={onOpenTerminal}
        ptyWriter={ptyWriter}
      />
    </section>
  )
}
