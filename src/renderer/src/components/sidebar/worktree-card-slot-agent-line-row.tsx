import React, { useCallback } from 'react'
import { ChevronDown, Loader2, Send, X } from 'lucide-react'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { useClaudeAgentRowView } from '@/components/dashboard/use-claude-agent-row-view'
import { translate } from '@/i18n/i18n'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import { agentVerdictStatusLine } from '@/lib/agent-status/presentation/agent-verdict-status-line'
import { cn } from '@/lib/utils'
import { getAgentRowPrimaryText } from '../../../../shared/agent-status/presentation/agent-row-primary-text'
import CacheTimer, { usePromptCacheCountdownForPane } from './workspace-card/activity/CacheTimer'
import { formatSummaryStateLabel } from './workspace-card/activity/worktree-card-agent-summary'
import { getCompactAgentSecondary } from './workspace-card/activity/worktree-card-compact-agent-row'
import type { AgentSendTarget } from './workspace-card/activity/use-worktree-agent-list-model'
import type { SlotAgentLine } from './worktree-card-slot-agent-signals'
import { slotForLine, type SlotLineSignal } from './worktree-card-slot-signal'
import { slotLabel, WorktreeCardSlot } from './WorktreeCardSlot'
import { SlotKindGlyph } from './worktree-card-slot-jump'

function lineText(agent: DashboardAgentRow, conversationName: string | null, now: number): string {
  const secondary = getCompactAgentSecondary(agent, now)
  const request = conversationName ?? getAgentRowPrimaryText(agent.entry)
  // The slot already says Failed/Interrupted; keep only the error detail, else the request.
  const verdictLine = agentVerdictStatusLine(agent.entry)
  if (verdictLine && secondary === verdictLine) {
    const separator = verdictLine.indexOf(': ')
    return separator > 0 ? verdictLine.slice(separator + 2) : request || secondary
  }
  // The type label is only the fallback; the user's request says more.
  if (secondary && secondary !== formatAgentTypeLabel(agent.agentType)) {
    return secondary
  }
  return request || secondary
}

function stopPropagation(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

export type SlotAgentLineRowProps = {
  line: SlotAgentLine
  /** A folded lead reports its subagents' most urgent state. */
  displaySignal: SlotLineSignal
  now: number
  offline: boolean
  focused: boolean
  showModel: boolean
  cacheTimerActive: boolean
  /** Lineage depth when the list is a tree; undefined renders a flat group item. */
  treeLevel?: number
  childCount?: number
  childrenExpanded?: boolean
  onToggleChildren?: () => void
  sendTarget?: AgentSendTarget
  onSendTarget: (paneKey: string) => void
  onActivate: (agent: DashboardAgentRow) => void
  onDismiss?: (paneKey: string) => void
}

/** One 2.0 agent line: icon, what it's doing or said, and its own slot. */
export const SlotAgentLineRow = React.memo(function SlotAgentLineRow({
  line,
  displaySignal,
  now,
  offline,
  focused,
  showModel,
  cacheTimerActive,
  treeLevel,
  childCount,
  childrenExpanded = false,
  onToggleChildren,
  sendTarget,
  onSendTarget,
  onActivate,
  onDismiss
}: SlotAgentLineRowProps): React.JSX.Element {
  const { agent } = line
  const view = useClaudeAgentRowView(agent)
  const highlighted = view ? view.current && view.focused : focused
  const conversationName = useAgentRowConversationName(agent)
  const isSubagent = agent.rowSource === 'subagent'
  const detail = lineText(agent, conversationName, now)
  const subagentName = isSubagent ? (conversationName ?? getAgentRowPrimaryText(agent.entry)) : ''
  const text = offline
    ? translate('sidebar.cardSlot.lastSeen', 'Last seen {{state}}', {
        state: formatSummaryStateLabel(line.dotState)
      }) + (detail ? ` · ${detail}` : '')
    : detail
  const quiet = offline || displaySignal.kind === 'seen' || displaySignal.kind === 'idle'
  const agentLabel = formatAgentTypeLabel(agent.agentType)
  const model = showModel ? (agent.entry.model?.trim() ?? '') : ''
  const cacheTimer = usePromptCacheCountdownForPane(agent.paneKey, cacheTimerActive)
  const hasChildren = typeof childCount === 'number' && childCount > 0 && Boolean(onToggleChildren)

  const act = useCallback(() => {
    if (sendTarget) {
      // Picking a send target: an eligible row sends; others explain why in their tooltip.
      if (sendTarget.status === 'eligible') {
        onSendTarget(agent.paneKey)
      }
      return
    }
    onActivate(agent)
  }, [agent, onActivate, onSendTarget, sendTarget])
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      act()
    },
    [act]
  )
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) {
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        act()
      } else if (hasChildren && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        // Tree convention: right opens, left closes.
        if ((event.key === 'ArrowRight') !== childrenExpanded) {
          event.preventDefault()
          event.stopPropagation()
          onToggleChildren?.()
        }
      }
    },
    [act, childrenExpanded, hasChildren, onToggleChildren]
  )
  const handleToggleChildren = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      onToggleChildren?.()
    },
    [onToggleChildren]
  )
  const handleDismiss = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      onDismiss?.(agent.paneKey)
    },
    [agent.paneKey, onDismiss]
  )

  // Unread and working move onto the agent icon; the slot keeps their time in the same tone.
  const iconBadge =
    !isSubagent && !offline && (displaySignal.kind === 'unread' || displaySignal.kind === 'working')
  const lineSlot = iconBadge ? (
    <WorktreeCardSlot
      signal={{ kind: 'time', at: displaySignal.at }}
      now={now}
      timeTone={displaySignal.kind === 'unread' ? 'unread' : 'working'}
    />
  ) : (
    <WorktreeCardSlot signal={slotForLine(displaySignal)} now={now} stale={offline} />
  )
  // A Needs you / Failed pill must stay readable on hover, so dismiss slides in beside it instead.
  const pillSlot = !offline && (displaySignal.kind === 'needs' || displaySignal.kind === 'failed')
  const dismissButton = onDismiss ? (
    <button
      type="button"
      className={cn(
        'z-10 inline-flex items-center justify-center text-muted-foreground/70 transition-opacity hover:text-foreground focus-visible:opacity-100 can-hover:group-hover/slot-line:opacity-100',
        pillSlot
          ? 'w-0 overflow-hidden opacity-0 focus-visible:ml-1 focus-visible:w-3 can-hover:group-hover/slot-line:ml-1 can-hover:group-hover/slot-line:w-3'
          : 'peer opacity-0'
      )}
      aria-label={translate(
        'auto.components.dashboard.DashboardAgentRow.b06e13fcf7',
        'Dismiss agent'
      )}
      title={translate('auto.components.dashboard.DashboardAgentRow.5ae84475cc', 'Dismiss')}
      onClick={handleDismiss}
      onMouseDown={stopPropagation}
      onKeyDown={stopPropagation}
    >
      <X className="size-3 shrink-0" />
    </button>
  ) : null
  const slot = sendTarget ? (
    sendTarget.status === 'eligible' ? (
      <span className="inline-flex h-4 shrink-0 items-center gap-1 rounded border border-worktree-sidebar-border px-1.5 text-3xs font-medium text-foreground">
        <Send className="size-2.5" aria-hidden />
        {translate('auto.components.dashboard.DashboardAgentRow.912e136cd9', 'Send')}
      </span>
    ) : sendTarget.status === 'sending' ? (
      <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
    ) : null
  ) : dismissButton && pillSlot ? (
    <span className="inline-flex shrink-0 items-center">
      {lineSlot}
      {dismissButton}
    </span>
  ) : dismissButton ? (
    // Time and dismiss share the slot; hover or keyboard focus swaps in the dismiss control.
    // Button comes first so the time can follow it as a `peer` without :has(); z-10 keeps it on top.
    <span className="grid shrink-0 items-center justify-items-end [&>*]:col-start-1 [&>*]:row-start-1">
      {dismissButton}
      <span className="transition-opacity peer-focus-visible:opacity-0 can-hover:group-hover/slot-line:opacity-0">
        {lineSlot}
      </span>
    </span>
  ) : (
    lineSlot
  )

  return (
    <div
      role={treeLevel !== undefined ? 'treeitem' : 'button'}
      tabIndex={0}
      draggable={false}
      aria-level={treeLevel}
      aria-expanded={hasChildren ? childrenExpanded : undefined}
      aria-current={view?.current ? 'true' : undefined}
      className={cn(
        'group/slot-line worktree-agent-row-hover flex h-[22px] w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm pr-1.5 pl-1 text-left text-2xs leading-none outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
        highlighted && 'bg-worktree-sidebar-accent',
        sendTarget?.status === 'sending' && 'cursor-progress opacity-75',
        sendTarget?.status === 'disabled' && 'cursor-default opacity-60'
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseDown={stopPropagation}
      onPointerDown={stopPropagation}
      title={sendTarget?.disabledReason ?? `${agentLabel} · ${text}`}
      data-worktree-card-slot-line={displaySignal.kind}
      data-focused-agent-pane={highlighted ? 'true' : undefined}
      data-agent-send-target={sendTarget?.status}
    >
      {/* A subagent's type is its name, not a provider; nesting already says whose it is. */}
      {isSubagent ? null : (
        <span className="relative inline-flex shrink-0" aria-label={agentLabel}>
          <AgentTypeIcon agentType={agent.agentType} size={13} />
          {iconBadge ? (
            // Unread and working sit on the agent's own icon, as they do on the card's leading icon.
            <span
              className="worktree-agent-line-badge"
              data-worktree-card-slot={displaySignal.kind}
              title={slotLabel(slotForLine(displaySignal))}
            >
              <SlotKindGlyph
                kind={displaySignal.kind}
                monitoring={displaySignal.monitoring === true}
                spinnerClassName="size-[7px]"
              />
            </span>
          ) : null}
        </span>
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          displaySignal.kind === 'unread' && !offline
            ? 'text-foreground'
            : quiet
              ? 'text-muted-foreground/70'
              : 'text-muted-foreground'
        )}
      >
        {subagentName && subagentName !== text ? (
          <>
            <span className="font-medium">{subagentName}</span>
            {text ? ` · ${text}` : null}
          </>
        ) : (
          text
        )}
      </span>
      {model ? (
        <span
          className="max-w-20 shrink-0 truncate font-mono text-3xs text-muted-foreground/70"
          title={model}
        >
          {model}
        </span>
      ) : null}
      {cacheTimer ? <CacheTimer startedAt={cacheTimer.startedAt} ttlMs={cacheTimer.ttlMs} /> : null}
      {hasChildren ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-0.5 rounded px-0.5 text-3xs tabular-nums text-muted-foreground/70 hover:bg-worktree-sidebar-accent hover:text-foreground"
          aria-expanded={childrenExpanded}
          aria-label={
            childrenExpanded
              ? translate(
                  'auto.components.dashboard.DashboardAgentChildDisclosure.hideChildAgents',
                  'Hide {{count}} child agents',
                  { count: childCount, defaultValue_one: 'Hide {{count}} child agent' }
                )
              : translate(
                  'auto.components.dashboard.DashboardAgentChildDisclosure.showChildAgents',
                  'Show {{count}} child agents',
                  { count: childCount, defaultValue_one: 'Show {{count}} child agent' }
                )
          }
          onClick={handleToggleChildren}
          onMouseDown={stopPropagation}
          onKeyDown={stopPropagation}
        >
          <ChevronDown
            className={cn('size-2.5 transition-transform', !childrenExpanded && '-rotate-90')}
            aria-hidden
          />
          {childCount}
        </button>
      ) : null}
      {slot}
    </div>
  )
})
