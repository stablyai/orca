import React, { useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DashboardAgentChildDisclosure } from './DashboardAgentChildDisclosure'
import { DashboardAgentRowMessage } from './DashboardAgentRowMessage'
import { DashboardAgentRowTrailingControls } from './DashboardAgentRowTrailingControls'
import { DashboardAgentRowToolStep } from './DashboardAgentRowToolStep'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'

// Why: the dashboard tracks its own rollup states (incl. 'idle'); narrow to the
// shared dot states for rendering, falling back to 'idle' for any unknown
// value so an unexpected state never crashes a row.
function asDotState(state: AgentStatusState | 'idle'): AgentDotState {
  switch (state) {
    case 'working':
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
      return state
  }
  return 'idle'
}

function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Why: surface the moment the agent most recently transitioned *into* done.
// When the current live state is done, use `stateStartedAt` (not `updatedAt`)
// — `updatedAt` is refreshed on within-state pings (tool/prompt) and would
// drift away from the true transition moment. For past dones, stateHistory
// entries already store the per-transition `startedAt` so we read it directly.
function lastEnteredDoneAt(agent: DashboardAgentRowData): number | null {
  const entry = agent.entry
  if (entry.state === 'done') {
    return entry.stateStartedAt
  }
  for (let i = entry.stateHistory.length - 1; i >= 0; i--) {
    if (entry.stateHistory[i].state === 'done') {
      return entry.stateHistory[i].startedAt
    }
  }
  return null
}

function stateDotTooltipLabel(agent: DashboardAgentRowData, dotState: AgentDotState): string {
  if (agent.entry.interrupted === true) {
    return 'Interrupted by user'
  }
  return agentStateLabel(dotState)
}

type Props = {
  agent: DashboardAgentRowData
  onDismiss: (paneKey: string) => void
  /** Navigate directly to the tab this agent lives in. paneKey is passed
   *  through so the caller can acknowledge (mark-visited) the specific row
   *  that was clicked, without having to re-derive it from the tab id. */
  onActivate: (tabId: string, paneKey: string) => void
  /**
   * Why: the relative-time labels ("Xm ago") need a periodic re-render to stay
   * honest. We accept `now` from a parent container so a single 30s tick owned
   * by the container drives every visible row, rather than each row running
   * its own setInterval. See useNow.ts for the shared hook — WorktreeCardAgents
   * owns the tick for the inline-in-card list.
   */
  now: number
  /**
   * Why: bold weight for the prompt rides on the enclosing workspace card's
   * unvisited signal, not on the per-agent state. Passed in from
   * WorktreeCardAgents so the workspace name and its agent rows share
   * the same "you haven't looked at this yet" rule — visiting the worktree
   * clears the signal, and the next render mutes both in lockstep.
   *
   * Optional so other callers can opt out and default to muted when their
   * surface carries the unread signal elsewhere.
   */
  isUnvisited?: boolean
  /**
   * Why: the inline-in-card variant sits in a tighter layout next to the
   * agent identity icon, so 'md' reads as a second ~12px glyph that users
   * can confuse with the agent icon. 'sm' keeps them visually distinct.
   * The full dashboard has more breathing room and prefers 'md' for leading-
   * slot presence, so default stays 'md'.
   */
  stateDotSize?: 'sm' | 'md'
  /**
   * Why: the inline-in-card variant lives next to a worktree card that the
   * user clicks to jump directly to the agent — a separate expand chevron
   * and a second identity glyph (Claude/Gemini/…) are redundant noise in
   * that tighter layout. The full dashboard keeps both, so these flags
   * default to showing them.
   */
  hideIdentityIcon?: boolean
  hideExpand?: boolean
  /** Reuse the row's hover tint to show the focused terminal pane's agent. */
  isFocusedPane?: boolean
  // Why: inline-card orchestration rows fold children under a leading chevron.
  childAgentCount?: number
  childAgentsExpanded?: boolean
  onToggleChildAgents?: () => void
  // Why: leaf siblings reserve the chevron gutter so state dots align.
  reserveDisclosureGutter?: boolean
  // Why: chevron indentation replaces fixed-offset lineage connector art.
  hideLineageConnectors?: boolean
  // Why: send-popover target mode temporarily turns sidebar rows into the
  // picker surface, so row clicks must send/no-op instead of navigating.
  sendTargetStatus?: 'eligible' | 'disabled' | 'sending'
  sendTargetDisabledReason?: string
  onSendTargetClick?: (paneKey: string) => void
}

const DashboardAgentRow = React.memo(function DashboardAgentRow({
  agent,
  onDismiss,
  onActivate,
  now,
  isUnvisited = false,
  stateDotSize = 'md',
  hideIdentityIcon = false,
  hideExpand = false,
  isFocusedPane = false,
  childAgentCount,
  childAgentsExpanded = false,
  onToggleChildAgents,
  reserveDisclosureGutter = false,
  hideLineageConnectors = false,
  sendTargetStatus,
  sendTargetDisabledReason,
  onSendTargetClick
}: Props) {
  const hasChildDisclosure =
    typeof childAgentCount === 'number' &&
    childAgentCount > 0 &&
    typeof onToggleChildAgents === 'function'
  const [expanded, setExpanded] = useState(false)
  const handleToggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])
  // Why: agent rows navigate directly to the agent's own tab, while the
  // surrounding worktree card navigates to whatever tab the worktree last had
  // focused. Stop propagation so the card click handler does not run second
  // and override our tab activation.
  const handleActivate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onActivate(agent.tab.id, agent.paneKey)
    },
    [onActivate, agent.tab.id, agent.paneKey]
  )
  const handleSendTargetClickCapture = useCallback(
    (e: React.MouseEvent) => {
      if (!sendTargetStatus) {
        return
      }
      const target = e.target
      if (
        target instanceof Element &&
        target.closest('button, a, input, textarea, select, [role="button"]')
      ) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (sendTargetStatus === 'eligible') {
        onSendTargetClick?.(agent.paneKey)
      }
    },
    [agent.paneKey, onSendTargetClick, sendTargetStatus]
  )
  const startedAt = agent.startedAt > 0 ? agent.startedAt : null
  const doneAt = lastEnteredDoneAt(agent)
  const prompt = agent.entry.prompt.trim()
  // Why: `agent.entry.prompt` is normalized to '' when the prompt is unknown
  // (fresh agent, missing telemetry). Rendering the row with an empty primary
  // slot would collapse the text column and leave the row with no human-
  // readable label — just a state dot and icon. Fall back to the state label
  // ("Working", "Done", "Waiting", …) so every row is identifiable at a
  // glance.
  const displayLabel = prompt || agentStateLabel(asDotState(agent.state))
  // Why: the tool row describes what the agent is *currently* doing; once it
  // leaves working, that line goes stale and misleads (a done row showing
  // "Bash: pnpm test" reads as if the command is still running). Gate tool
  // fields on `state === 'working'`. The assistant message is the opposite
  // — it's the reply, most useful on `done`, so we always show it.
  const isWorking = agent.state === 'working'
  const toolName = isWorking ? (agent.entry.toolName?.trim() ?? '') : ''
  const toolInput = isWorking ? (agent.entry.toolInput?.trim() ?? '') : ''
  const lastAssistantMessage = agent.entry.lastAssistantMessage?.trim() ?? ''
  const isInterrupted = agent.entry.interrupted === true
  const lineage = agent.lineage
  const isLineageChild = lineage?.depth === 1
  const lineageChildCount = lineage?.childCount ?? 0
  const participatesInLineage = isLineageChild || lineageChildCount > 0
  const identityTitle =
    lineageChildCount > 0
      ? `${formatAgentTypeLabel(agent.agentType)} - dispatched ${lineageChildCount} ${
          lineageChildCount === 1 ? 'agent' : 'agents'
        }`
      : formatAgentTypeLabel(agent.agentType)
  // Why: interrupted is a terminal outcome the user needs to scan in the
  // leading state column; the secondary-line text below provides the
  // explanation without competing with the prompt or timestamp.
  const dotState: AgentDotState = isInterrupted ? 'interrupted' : asDotState(agent.state)
  const dotTooltipLabel = stateDotTooltipLabel(agent, dotState)

  // Why: always show the chevron to keep the row's right edge stable — a
  // conditional control would appear/disappear as agent content grows and
  // shrinks mid-turn, which reads as UI flicker. Expanding a row whose
  // content already fits is a no-op; the cost of an occasionally inert
  // toggle is much lower than layout jitter on every live row.

  const startedTimeAgo = startedAt !== null ? formatTimeAgo(startedAt, now) : null
  const doneTimeAgo = doneAt !== null ? formatTimeAgo(doneAt, now) : null
  const relativeTimestamp = doneTimeAgo ?? startedTimeAgo
  const tsParts: string[] = []
  if (startedTimeAgo !== null) {
    tsParts.push(`started ${startedTimeAgo}`)
  }
  if (doneTimeAgo !== null) {
    tsParts.push(`done ${doneTimeAgo}`)
  }

  const titleParts = sendTargetDisabledReason ? [sendTargetDisabledReason, ...tsParts] : tsParts

  return (
    // Why: NOT role="button" / tabIndex={0}. The row contains real <button>
    // children (dismiss X, expand chevron) and tooltip triggers that forward
    // button semantics to their children — nesting them inside an outer
    // role=button violates ARIA's "no interactive content inside interactive
    // content" rule and breaks keyboard/AT navigation. Keyboard users reach
    // the agent via the child buttons and the tab switcher; the outer <div>
    // stays a plain clickable surface for pointer activation.
    <div
      onClickCapture={handleSendTargetClickCapture}
      onClick={handleActivate}
      className={cn(
        // Why: this row owns the timestamp/X hover boundary; anonymous
        // ancestor groups from workspace cards must not reveal every row's X.
        'group/agent-row relative flex flex-col -ml-2 py-1',
        isLineageChild ? 'pl-5 pr-2' : 'px-2',
        // Why: inline agent rows sit inside a hoverable workspace card, so
        // their hover wash must stay softer than the parent card highlight.
        // The focused-pane state reuses the same class via data attribute.
        'cursor-pointer rounded-sm worktree-agent-row-hover',
        hasChildDisclosure && 'worktree-agent-lineage-parent-row',
        isLineageChild && 'worktree-agent-lineage-child-row',
        sendTargetStatus === 'sending' && 'cursor-progress opacity-75',
        sendTargetStatus === 'disabled' && 'cursor-default opacity-60'
      )}
      data-focused-agent-pane={isFocusedPane ? 'true' : undefined}
      data-agent-send-target={sendTargetStatus}
      title={titleParts.length > 0 ? titleParts.join(' • ') : undefined}
      role={participatesInLineage ? 'treeitem' : undefined}
      aria-level={participatesInLineage ? (lineage?.depth ?? 0) + 1 : undefined}
    >
      {lineageChildCount > 0 && !hideLineageConnectors ? (
        <span
          aria-hidden
          data-agent-lineage-parent-connector
          className="pointer-events-none absolute bottom-[-0.75rem] left-[13px] top-[1.05rem] border-l-[1.5px] border-muted-foreground/45 dark:border-muted-foreground/35"
        />
      ) : null}
      {isLineageChild && !hideLineageConnectors ? (
        <span
          aria-hidden
          data-agent-lineage-connector={lineage?.isLastSibling === false ? 'branch' : 'last'}
          className="pointer-events-none absolute bottom-[-1px] left-[13px] top-[-1px] w-3"
        >
          <span
            className={cn(
              'absolute left-0 border-l-[1.5px] border-muted-foreground/45 dark:border-muted-foreground/35',
              lineage?.isFirstSibling ? 'top-[-0.9rem]' : 'top-[-1px]',
              lineage?.isLastSibling
                ? lineage?.isFirstSibling
                  ? 'h-[1.6rem]'
                  : 'h-[calc(0.7rem+1px)]'
                : 'bottom-[-1px]'
            )}
          />
          <span className="absolute left-0 top-[0.7rem] w-1.5 border-t-[1.5px] border-muted-foreground/45 dark:border-muted-foreground/35" />
        </span>
      ) : null}
      <div className="flex items-center gap-1.5">
        <DashboardAgentChildDisclosure
          childAgentCount={childAgentCount}
          childAgentsExpanded={childAgentsExpanded}
          onToggleChildAgents={onToggleChildAgents}
          reserveDisclosureGutter={reserveDisclosureGutter}
        />
        {/* Why: state indicator lives in the leading gutter so the user's
            eye can sweep one column and know which rows are working,
            waiting, or done at a glance — the list-view convention (Linear,
            GitHub issues, JetBrains TODO). Replaces the earlier left accent
            bar + right-side dot combo, which double-encoded state. Size md
            gives the glyph enough presence for the leading slot without
            overpowering the prompt text. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex shrink-0 items-center justify-center"
              aria-label={dotTooltipLabel}
            >
              <AgentStateDot state={dotState} size={stateDotSize} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {dotTooltipLabel}
          </TooltipContent>
        </Tooltip>
        {/* Why: identity (Claude/Codex/Gemini/…) sits inline with the prompt
            so the reader gets "state → who → what they said" left-to-right
            on the top row. The sub-rows (tool step, assistant response) are
            about the same agent and do not need the icon repeated next to
            them — keeping the icon only on the prompt row lets the sub-rows
            indent under the prompt text cleanly. */}
        {!hideIdentityIcon && (
          <span className="inline-flex shrink-0" title={identityTitle}>
            <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={14} />
          </span>
        )}
        {/* Why: animate between a 1-line clipped height and the content's
            natural height using Chromium's `interpolate-size: allow-keywords`
            — this is the only way to transition a `height` property to/from
            `auto` without measuring sizes in JS. Falls back to an instant
            swap in engines that don't support it. The inner span keeps
            overflow-hidden so the truncate→wrap class flip stays clipped
            during the interpolation.

            Weight tracks the workspace's unvisited signal (isUnvisited):
            bold + full foreground for agents inside a workspace the user
            hasn't looked at yet, normal + muted once they've visited. This
            keeps the prompt row's weight in lockstep with the workspace
            name above it — one attention axis, not two.

            Rendered unconditionally with a state-label fallback so rows
            without a prompt (fresh/unknown) still have a human-readable
            primary label instead of an empty text column. */}
        <span
          className={cn(
            'block min-w-0 flex-1 overflow-hidden text-[11px] leading-snug',
            'transition-[height] duration-200 ease-out [interpolate-size:allow-keywords]',
            expanded ? 'h-auto whitespace-pre-wrap break-words' : 'h-[1lh] truncate',
            isUnvisited ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground',
            // Why: the selected-row fill washes out muted text — keep it readable.
            isFocusedPane && !isUnvisited && 'text-foreground/90'
          )}
          title={displayLabel}
        >
          {displayLabel}
        </span>
        {/* Why: "+N" badge mirrors the leading chevron — without it the
            parent row reads identical to a leaf row when collapsed, and the
            child count is invisible. Hidden when expanded because the
            children are visible directly below. */}
        {hasChildDisclosure && !childAgentsExpanded && (
          <span
            className="shrink-0 text-[10px] font-normal leading-none text-muted-foreground/70 tabular-nums"
            aria-hidden
          >
            +{childAgentCount}
          </span>
        )}
        <DashboardAgentRowTrailingControls
          paneKey={agent.paneKey}
          relativeTimestamp={relativeTimestamp}
          expanded={expanded}
          hideExpand={hideExpand}
          sendTargetStatus={sendTargetStatus}
          onDismiss={onDismiss}
          onToggleExpanded={handleToggleExpanded}
          onSendTargetClick={onSendTargetClick}
        />
      </div>
      <DashboardAgentRowToolStep
        expanded={expanded}
        isWorking={isWorking}
        toolName={toolName}
        toolInput={toolInput}
      />
      <DashboardAgentRowMessage
        expanded={expanded}
        isInterrupted={isInterrupted}
        lastAssistantMessage={lastAssistantMessage}
      />
    </div>
  )
})

export default DashboardAgentRow
