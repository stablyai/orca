/* eslint-disable max-lines */
import React, { useState, useCallback } from 'react'
import { X, Wrench, ChevronDown, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DashboardAgentChildDisclosure } from './DashboardAgentChildDisclosure'
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
  // Why: stop propagation so clicking the X doesn't also fire the worktree
  // card's click handler (which navigates away from the dashboard).
  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onDismiss(agent.paneKey)
    },
    [onDismiss, agent.paneKey]
  )
  // Why: the chevron toggles expand-collapse and must not propagate — clicks
  // on it would otherwise bubble to the row's activate handler and navigate
  // away the instant the user tried to reveal the full text. Stop mousedown
  // too so focus-based navigation on the parent can't fire first.
  const handleToggleExpand = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setExpanded((prev) => !prev)
  }, [])
  const stopMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])
  // Why: nested buttons (dismiss X, expand chevron) are real <button>s whose
  // native Enter/Space handling fires their onClick. Stopping Enter/Space
  // propagation (not preventDefault) preserves native button activation while
  // defending against any ancestor key handlers that might otherwise react to
  // the bubbled event.
  const stopKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation()
    }
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
  const handleInlineSendTargetClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
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

  const tsParts: string[] = []
  if (startedAt !== null) {
    tsParts.push(`started ${formatTimeAgo(startedAt, now)}`)
  }
  if (doneAt !== null) {
    tsParts.push(`done ${formatTimeAgo(doneAt, now)}`)
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
            isUnvisited ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground'
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
        {/* Why: right cluster keeps passive time and dismiss affordance in one
            place. State belongs in the leading gutter; repeating it here as
            text makes interrupted rows look like the old badge treatment. */}
        <span className="relative ml-auto flex h-3.5 w-12 shrink-0 items-center justify-end">
          {(sendTargetStatus === 'eligible' || sendTargetStatus === 'sending') && (
            <button
              type="button"
              onClick={handleInlineSendTargetClick}
              onMouseDown={stopMouseDown}
              onKeyDown={stopKeyDown}
              disabled={sendTargetStatus === 'sending'}
              className={cn(
                'worktree-agent-send-target-button absolute right-0 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium leading-none transition-[background-color,border-color,color,opacity]',
                sendTargetStatus === 'sending' && 'cursor-progress opacity-75'
              )}
              aria-label="Send to this agent"
              title="Send to this agent"
            >
              <Send className="size-3" />
              <span>Send</span>
            </button>
          )}
          {/* Why: timestamp and dismiss-X share a single slot so passive
              rows show "time ago" and hovered rows swap in the X — no
              reserved-space gap, no competing columns. Grid stacks both
              children in cell 1,1 so the slot width is the larger of the
              two (usually the timestamp, e.g. "just now" / "12m ago"),
              which keeps the chevron's column stable whether or not the
              row is hovered. Using opacity (not display:none) lets us
              fade the crossfade instead of snapping, and keyboard focus
              on the hidden X still activates it because `opacity-0`
              doesn't remove it from the tab order. */}
          {!sendTargetStatus && (startedAt !== null || doneAt !== null) && (
            <span className="relative grid grid-cols-1 grid-rows-1 shrink-0 items-center justify-items-end">
              <span
                className={cn(
                  '[grid-area:1/1] pointer-events-none text-[10px] leading-none text-muted-foreground/60',
                  'transition-opacity duration-150',
                  'group-hover/agent-row:opacity-0'
                )}
                aria-hidden
              >
                {doneAt !== null
                  ? formatTimeAgo(doneAt, now)
                  : startedAt !== null
                    ? formatTimeAgo(startedAt, now)
                    : null}
              </span>
              <button
                type="button"
                onClick={handleDismiss}
                onMouseDown={stopMouseDown}
                onKeyDown={stopKeyDown}
                className={cn(
                  '[grid-area:1/1] inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground',
                  'opacity-0 transition-opacity duration-150',
                  'group-hover/agent-row:opacity-100 focus-visible:opacity-100'
                )}
                aria-label="Dismiss agent"
                title="Dismiss"
              >
                <X className="size-3.5" />
              </button>
            </span>
          )}
          {/* Why: when there is no timestamp yet (fresh agent, never
              reported), the grid slot above does not render — show the X
              as a standalone hover-only control so dismiss is still
              reachable. Rare path; most rows have a timestamp the moment
              they start. */}
          {!sendTargetStatus && startedAt === null && doneAt === null && (
            <button
              type="button"
              onClick={handleDismiss}
              onMouseDown={stopMouseDown}
              onKeyDown={stopKeyDown}
              className={cn(
                'inline-flex shrink-0 items-center justify-center text-muted-foreground/70 hover:text-foreground',
                'opacity-0 transition-opacity duration-150',
                'group-hover/agent-row:opacity-100 focus-visible:opacity-100'
              )}
              aria-label="Dismiss agent"
              title="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          )}
          {/* Why: chevron points down when collapsed (content below is
              available) and rotates 180° to point up when expanded
              (content is showing above the fold line). Single glyph
              with a transform animates smoothly; swapping between two
              glyphs (ChevronDown / ChevronUp) would snap because the
              old node unmounts. Invisible placeholder keeps vertical
              alignment stable across rows when nothing is expandable
              so the row-trailing edge stays stable. */}
          {!hideExpand && (
            <button
              type="button"
              onClick={handleToggleExpand}
              onMouseDown={stopMouseDown}
              onKeyDown={stopKeyDown}
              className="inline-flex shrink-0 items-center justify-center text-muted-foreground/60 hover:text-foreground"
              aria-label={expanded ? 'Collapse details' : 'Expand details'}
              aria-expanded={expanded}
            >
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-150',
                  expanded && 'rotate-180'
                )}
              />
            </button>
          )}
        </span>
      </div>
      {/* Why: tool row and message row both carry different info — tool shows
          the mechanical step (Bash: ...), message shows the agent's narration
          ("let me verify the test ordering"). Antigravity can emit working
          hooks without tool metadata between tool events, so the empty tool
          slot must be a real line box instead of whitespace that can collapse.
          Tool slot only reserves height while working, since done/blocked rows
          shouldn't show a dangling wrench. */}
      {isWorking && (
        <div
          data-agent-row-tool-slot=""
          className="mt-0.5 min-w-0 pl-5 text-[10px] leading-snug text-muted-foreground/70"
        >
          {toolName ? (
            <>
              {/* Why: header (wrench + tool name) stays on one line. When
                  collapsed, the input truncates inline next to the name. When
                  expanded, the input moves to its own block below so long
                  commands wrap to a consistent left margin instead of the
                  jagged shape that flex-wrapping produces. */}
              <div
                data-agent-row-tool-header="true"
                className={cn(
                  'flex h-[1lh] min-w-0 items-center gap-1',
                  !expanded && 'overflow-hidden'
                )}
              >
                <Wrench className="size-2.5 shrink-0" />
                <code className="shrink-0 font-mono text-[10px]">{toolName}</code>
                {!expanded && toolInput && (
                  <span className="min-w-0 truncate text-muted-foreground/60" title={toolInput}>
                    {toolInput}
                  </span>
                )}
              </div>
              {/* Why: grid-rows [0fr]→[1fr] is the CSS-only height animation
                  pattern — outer grid track interpolates smoothly while the
                  inner min-h-0 + overflow-hidden clips content during the
                  transition. This avoids measuring heights in JS and still
                  animates unknown content sizes. */}
              {toolInput && (
                <div
                  className={cn(
                    'grid transition-[grid-template-rows,margin-top] duration-200 ease-out',
                    expanded ? 'mt-0.5 grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  )}
                >
                  <pre className="min-h-0 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground/60">
                    {toolInput}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <span data-agent-row-tool-placeholder="true" aria-hidden className="block h-[1lh]" />
          )}
        </div>
      )}
      {/* Why: message slot is always reserved in collapsed view so the row
          height stays fixed as lastAssistantMessage arrives/clears. The
          expand animation lives on the CommentMarkdown itself (height +
          interpolate-size) so the body reveals smoothly instead of snapping
          open. When the message is empty we still render a placeholder in
          the collapsed view to preserve the reserved line height.

          Interrupted gets its visible text on this secondary line, where the
          agent response normally appears. That keeps the prompt line clean
          while making the red status dot's meaning visible without hover. */}
      {isInterrupted || lastAssistantMessage ? (
        <div className="mt-0.5 flex min-w-0 items-start gap-1.5 pl-5">
          {isInterrupted && (
            <span
              className="shrink-0 text-[10px] leading-snug text-muted-foreground/80"
              aria-label="Interrupted by user"
            >
              interrupted
            </span>
          )}
          {lastAssistantMessage && (
            <CommentMarkdown
              content={lastAssistantMessage}
              // Why: animate between a 1-line clipped height and the content's
              // natural height using Chromium's `interpolate-size: allow-keywords`
              // so the message body expands/collapses smoothly instead of
              // snapping. Height transition + overflow-hidden keeps the inline-
              // flattened preview clipped during the interpolation. Render the
              // markdown in both states; in the collapsed view we force every
              // nested element inline so `truncate` can ellipsize the whole
              // thing on one line. The [&_*]:inline descendant selector flattens
              // the markdown tree (lists, pre, headings, blockquotes) into inline
              // flow; block margins and list markers are suppressed by
              // [&_*]:!m-0 / [&_ul]:list-none so the preview reads as a single
              // clean line.
              className={cn(
                'min-w-0 flex-1 overflow-hidden text-[10px] leading-snug text-muted-foreground/80',
                'transition-[height] duration-200 ease-out [interpolate-size:allow-keywords]',
                expanded ? 'h-auto' : 'h-[1lh]',
                // Why: in collapsed mode we need a single truncated line. Markdown
                // blocks (pre, lists, headings) are flattened inline and forced
                // to inherit `white-space: nowrap` so <pre>/<code>'s preserved
                // newlines don't break out of the truncation container. The
                // `!` prefixes override CommentMarkdown's own layout styles so
                // nothing (margins, list markers, block line-breaks) can push
                // the preview onto a second line.
                !expanded &&
                  'truncate whitespace-nowrap [&_*]:inline [&_*]:!whitespace-nowrap [&_*]:!m-0 [&_*]:!p-0 [&_ul]:list-none [&_ol]:list-none [&_br]:hidden'
              )}
              title={!expanded ? lastAssistantMessage : undefined}
            />
          )}
        </div>
      ) : (
        !expanded && (
          <div className="mt-0.5 pl-5 text-[10px] leading-snug text-muted-foreground/70"> </div>
        )
      )}
    </div>
  )
})

export default DashboardAgentRow
