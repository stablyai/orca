import { useState } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNow } from '@/hooks/use-now'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader,
  subagentStateLabel
} from '../../../../shared/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../../shared/native-chat-subagent-summary'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
} from '../../../../shared/native-chat-types'
import { formatNativeChatDuration } from './NativeChatWorkingStatus'
import { nativeChatSubagentEntryRuns } from './native-chat-subagent-sections'
import { sayNativeChatSubagentGroupTranslated as say } from './native-chat-subagent-group-words-text'

const STATE_DOT_CLASS: Record<NativeChatSubagentState, string> = {
  working: 'bg-foreground/70',
  idle: 'bg-muted-foreground/40',
  completed: 'bg-muted-foreground/60',
  failed: 'bg-destructive',
  stopped: 'bg-muted-foreground',
  unverifiable: 'bg-muted-foreground'
}

/**
 * The group's identity glyph, fixed across every state — a settling row must not
 * appear to change identity. State is carried by {@link StatusDot} and the tone
 * of the words beside it.
 *
 * SWAP POINT: once the shared category-icon component lands (PR #18760), this
 * whole component becomes that component asked for the `bot` category, which is
 * the same glyph the individual `subAgentActivity` rows use.
 */
function SubagentGlyph(): React.JSX.Element {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-chat-foreground-faint">
      <Bot aria-hidden="true" className="size-3.5" />
    </span>
  )
}

/** `pulsing` is separate from `state` so a group that is still working can show
 *  a failed sibling's colour without losing its in-flight cue. */
export function StatusDot({
  state,
  pulsing = false
}: {
  state: NativeChatSubagentState
  pulsing?: boolean
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        STATE_DOT_CLASS[state],
        pulsing && 'animate-pulse motion-reduce:animate-none'
      )}
    />
  )
}

/** Leaf so the shared 1s clock re-renders only the digits, never the roster. */
function SubagentElapsed({
  startedAt,
  settledAt,
  counting
}: {
  startedAt: number
  settledAt: number | null
  counting: boolean
}): React.JSX.Element {
  const now = useNow(1_000, counting)
  const end = counting ? now : (settledAt ?? now)
  return <>{formatNativeChatDuration(Math.max(0, (end - startedAt) / 1000))}</>
}

/** A roster's entries, one per child. A child with a section is its head: its entry
 *  opens and closes it, and its rows follow the entry. */
export function NativeChatSubagentEntries({
  agents,
  sections,
  onSetSectionOpen,
  className
}: {
  agents: readonly NativeChatSubagentEntry[]
  sections?: ReadonlyMap<string, boolean>
  onSetSectionOpen?: (agentId: string, open: boolean) => void
  className?: string
}): React.JSX.Element {
  return (
    <ul className={cn('space-y-0.5', className)}>
      {agents.map((agent) => {
        const state = normalizeSubagentState(agent.state)
        const sectionOpen = sections?.get(agent.id)
        const entry = (
          <>
            <StatusDot state={state} pulsing={state === 'working'} />
            <span
              className={cn(
                'min-w-0 truncate font-sans text-[13px]',
                state === 'idle' ? 'text-chat-foreground-faint' : 'text-chat-foreground'
              )}
            >
              {agent.label}
            </span>
            <span className="ml-auto shrink-0 font-sans text-xs tabular-nums text-chat-foreground-faint">
              {subagentStateLabel(state, 1, 1, say)}
              {typeof agent.tokens === 'number' ? ` · ${formatSubagentTokens(agent.tokens)}` : null}
            </span>
          </>
        )
        return (
          <li key={agent.id}>
            {sectionOpen === undefined ? (
              <div className="flex items-center gap-1.5 py-0.5">{entry}</div>
            ) : (
              <button
                type="button"
                onClick={() => onSetSectionOpen?.(agent.id, !sectionOpen)}
                aria-expanded={sectionOpen}
                className="group/subagent-entry flex w-full items-center gap-1.5 rounded-md py-0.5 text-left hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              >
                {entry}
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'size-3.5 shrink-0 text-chat-foreground-faint transition-all motion-reduce:transition-none',
                    sectionOpen
                      ? 'rotate-90 opacity-100'
                      : 'opacity-0 group-hover/subagent-entry:opacity-100'
                  )}
                />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** One spawn group: how many children are working, their settled verdict, and
 *  the tokens they consumed. Each child is one entry here; the child's own rows
 *  are never the conversation's. A child the session spawned shows them under its
 *  entry, open while the running session's newest output is part of delegating to
 *  it; the entry is where the reader overrides that. This row draws its entries
 *  through the first open one; the transcript draws that child's rows, then the rest.
 *
 *  Every state is drawn exactly as the journal recorded it. Turn state is NOT
 *  consulted: `spawn_agent` children outlive the turn that spawned them and keep
 *  reporting into this group long after a newer turn opened, so a turn boundary
 *  is a fact about the turn and never evidence that contact with a child was
 *  lost. Only a host can say that, and one does: `CodexSubagentRoster.settleSession`
 *  when the provider goes away, and `staleSubagentRosterRevisions` on the next
 *  journal open when the host itself died mid-flight. */
export function NativeChatSubagentRun({
  block,
  open: heldOpen,
  onSetOpen,
  sections,
  onSetSectionOpen
}: {
  block: NativeChatSubagentGroupBlock
  /** Whether the entries show, when the transcript holds that past this row's lifetime. */
  open?: boolean
  onSetOpen?: (open: boolean) => void
  /** The children whose rows open under their entries, and whether each is open. */
  sections?: ReadonlyMap<string, boolean>
  onSetSectionOpen?: (agentId: string, open: boolean) => void
}): React.JSX.Element | null {
  const [localOpen, setLocalOpen] = useState(false)
  const open = heldOpen ?? localOpen
  const setOpen = onSetOpen ?? setLocalOpen
  const agents = block.agents
  // Not memoized: its words follow the reader's language, which can change under the same roster.
  const header = nativeChatSubagentGroupHeader(agents, say)
  if (header.total === 0) {
    return null
  }
  const { working, headline, verdictState, verdict, alertState, alert, clockStartedAt } = header

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group/subagent-run flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left font-sans text-[13px] native-chat-message-text leading-relaxed text-chat-foreground-faint hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-expanded={open}
        aria-live="polite"
      >
        <SubagentGlyph />
        <StatusDot state={alertState ?? verdictState} pulsing={working} />
        <span className={cn('min-w-0 truncate', working && 'text-chat-foreground')}>
          {headline}
        </span>
        <span className="ml-auto shrink-0 font-sans text-xs tabular-nums text-chat-foreground-faint">
          {verdict}
          {alert === null ? null : ` +${alert}`}
          {clockStartedAt !== null ? (
            // The row is a live region, and this clock reticks every second: left
            // exposed it announces a new duration every second and buries the
            // state changes worth hearing. Readable again once it stops moving.
            <span aria-hidden={working || undefined}>
              {' · '}
              <SubagentElapsed
                startedAt={clockStartedAt}
                settledAt={header.settledAt}
                counting={working}
              />
            </span>
          ) : null}
          {header.tokens !== null ? ` · ${header.tokens}` : null}
        </span>
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-chat-foreground-faint transition-all motion-reduce:transition-none',
            open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover/subagent-run:opacity-100'
          )}
        />
      </button>
      {open ? (
        <NativeChatSubagentEntries
          agents={sections ? nativeChatSubagentEntryRuns(agents, sections)[0]! : agents}
          sections={sections}
          onSetSectionOpen={onSetSectionOpen}
          className="mt-1"
        />
      ) : null}
    </div>
  )
}
