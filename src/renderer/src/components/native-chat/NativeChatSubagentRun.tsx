import { useState } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNow } from '@/hooks/use-now'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader,
  subagentStateLabel
} from '../../../../shared/native-chat/transcript/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../../shared/native-chat/transcript/native-chat-subagent-summary'
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

/** Keep the identity glyph fixed as state changes; convey status through the dot and text. */
function SubagentGlyph(): React.JSX.Element {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-chat-foreground-faint">
      <Bot aria-hidden="true" className="size-3.5" />
    </span>
  )
}

/** Keep failure color independent of pulsing so a failed sibling cannot hide ongoing work. */
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

/** Each child entry controls its section; the transcript inserts its rows after the entry. */
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
                'min-w-0 truncate font-sans text-sm',
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
                className="group/subagent-entry flex w-full items-center gap-1.5 rounded-md py-0.5 text-left hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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

/** Trust journal child states: children outlive their spawning turn, and only host/provider settlement proves lost contact. */
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
        className="group/subagent-run flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left font-sans text-sm leading-relaxed text-chat-foreground-faint hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
            // Hide ticking durations from live announcements; expose them once settled.
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
