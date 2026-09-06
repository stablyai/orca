import { useMemo, useState } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import {
  normalizeSubagentState,
  summarizeSubagentGroup
} from '../../../../shared/native-chat-subagent-summary'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
} from '../../../../shared/native-chat-types'
import { formatNativeChatDuration } from './NativeChatWorkingStatus'

/**
 * A roster read back from the journal after the writing process is gone.
 *
 * The state map is process-local and Codex resume replays no non-message items,
 * so no event will ever settle a child that was working when the host died.
 * Once the owning turn is no longer live, such a child is `unverifiable` — the
 * repo's loss-of-contact verdict. It is NOT evidence the child exited.
 */
export function reconcileSubagentRoster(
  agents: readonly NativeChatSubagentEntry[],
  turnIsLive: boolean
): NativeChatSubagentEntry[] {
  return agents.map((agent) => {
    const state = normalizeSubagentState(agent.state)
    const reconciled: NativeChatSubagentState =
      state === 'working' && !turnIsLive ? 'unverifiable' : state
    return reconciled === agent.state ? agent : { ...agent, state: reconciled }
  })
}

/** Compact token counts: the row shows scale, not an exact ledger. */
function formatSubagentTokens(tokens: number): string {
  if (tokens < 1_000) {
    return String(Math.round(tokens))
  }
  const scaled = tokens < 1_000_000 ? tokens / 1_000 : tokens / 1_000_000
  const suffix = tokens < 1_000_000 ? 'k' : 'M'
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`
}

/** The group's one-line verdict. A single-child group reads as a bare word; any
 *  larger group always carries the count, because "working" alone would not say
 *  how many of the children it covers. `completed` never takes one: every child
 *  finishing is the whole group finishing. */
function subagentStateLabel(
  state: NativeChatSubagentState,
  count: number,
  groupTotal: number
): string {
  if (state === 'completed') {
    return translate('components.native-chat.subagents.state.completed', 'completed')
  }
  if (groupTotal <= 1) {
    switch (state) {
      case 'working':
        return translate('components.native-chat.subagents.state.working', 'working')
      case 'idle':
        return translate('components.native-chat.subagents.state.idle', 'idle')
      case 'failed':
        return translate('components.native-chat.subagents.state.failed', 'failed')
      case 'stopped':
        return translate('components.native-chat.subagents.state.stopped', 'stopped')
      case 'unverifiable':
        return translate('components.native-chat.subagents.state.unverifiable', 'unverifiable')
    }
  }
  switch (state) {
    case 'working':
      return translate(
        'components.native-chat.subagents.state.workingCount',
        '{{value0}} working',
        {
          value0: count
        }
      )
    case 'idle':
      return translate('components.native-chat.subagents.state.idleCount', '{{value0}} idle', {
        value0: count
      })
    case 'failed':
      return translate('components.native-chat.subagents.state.failedCount', '{{value0}} failed', {
        value0: count
      })
    case 'stopped':
      return translate(
        'components.native-chat.subagents.state.stoppedCount',
        '{{value0}} stopped',
        {
          value0: count
        }
      )
    case 'unverifiable':
      return translate(
        'components.native-chat.subagents.state.unverifiableCount',
        '{{value0}} unverifiable',
        { value0: count }
      )
  }
}

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
    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
      <Bot aria-hidden="true" className="size-3.5" />
    </span>
  )
}

/** `pulsing` is separate from `state` so a group that is still working can show
 *  a failed sibling's colour without losing its in-flight cue. */
function StatusDot({
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

/** One spawn group: how many children are working, their settled verdict, and
 *  the tokens they consumed. Deliberately flat — children are summarized here,
 *  never nested into the transcript as turns of their own. */
export function NativeChatSubagentRun({
  block,
  activeTurnIsWorking
}: {
  block: NativeChatSubagentGroupBlock
  /** False once the owning turn is no longer live; undefined means unknown. */
  activeTurnIsWorking?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const agents = useMemo(
    () => reconcileSubagentRoster(block.agents, activeTurnIsWorking !== false),
    [block.agents, activeTurnIsWorking]
  )
  const summary = useMemo(() => summarizeSubagentGroup(agents), [agents])
  if (summary.total === 0) {
    return null
  }

  const working = summary.working > 0
  const headline = working
    ? summary.total === 1
      ? translate('components.native-chat.subagents.startedOne', 'Kicked off 1 subagent')
      : translate('components.native-chat.subagents.startedN', 'Kicked off {{value0}} subagents', {
          value0: summary.total
        })
    : summary.total === 1
      ? translate('components.native-chat.subagents.ranOne', 'Ran 1 subagent')
      : translate('components.native-chat.subagents.ranN', 'Ran {{value0}} subagents', {
          value0: summary.total
        })
  const verdictState: NativeChatSubagentState = working
    ? 'working'
    : (summary.settledState ?? 'idle')
  const verdict = working
    ? subagentStateLabel('working', summary.working, summary.total)
    : subagentStateLabel(verdictState, summary.settledCount, summary.total)
  // A child that already failed must not wait for its siblings to be readable.
  const alertState = working ? summary.adverseState : null
  const alert =
    alertState === null ? null : subagentStateLabel(alertState, summary.adverseCount, summary.total)
  // A roster restored from the journal after the host died holds children that
  // latched `unverifiable` with no terminal timestamp. Their run length is
  // unknown, and measuring it to `now` would report the time since the crash as
  // how long they ran — on a row that is not even counting.
  const clockStartedAt = working || summary.settledAt !== null ? summary.startedAt : null

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left text-sm leading-relaxed text-muted-foreground hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-expanded={open}
        aria-live="polite"
      >
        <SubagentGlyph />
        <StatusDot state={alertState ?? verdictState} pulsing={working} />
        <span className={cn('min-w-0 flex-1 truncate', working && 'text-foreground/85')}>
          {headline}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
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
                settledAt={summary.settledAt}
                counting={working}
              />
            </span>
          ) : null}
          {summary.tokens !== null
            ? ` · ${translate('components.native-chat.subagents.tokens', '{{value0}} tokens', {
                value0: formatSubagentTokens(summary.tokens)
              })}`
            : null}
        </span>
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-all',
            open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        />
      </button>
      {open ? (
        <ul className="mt-1 space-y-0.5">
          {agents.map((agent) => {
            const state = normalizeSubagentState(agent.state)
            return (
              <li key={agent.id} className="flex items-center gap-1.5 py-0.5">
                <StatusDot state={state} pulsing={state === 'working'} />
                <code
                  className={cn(
                    'min-w-0 truncate font-mono text-[11px]',
                    state === 'idle' ? 'text-muted-foreground/70' : 'text-foreground/80'
                  )}
                >
                  {agent.label}
                </code>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {subagentStateLabel(state, 1, 1)}
                  {typeof agent.tokens === 'number'
                    ? ` · ${formatSubagentTokens(agent.tokens)}`
                    : null}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
