import { Bot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useNow } from '@/hooks/use-now'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader,
  subagentStateLabel
} from '../../../../../shared/native-chat/transcript/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import {
  subagentEntryDetail,
  subagentEntryRunsOn,
  subagentMessageText,
  subagentRoleLabel
} from '../../../../../shared/native-chat/transcript/native-chat-subagent-entry-detail'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
} from '../../../../../shared/native-chat/native-chat-types'
import { formatNativeChatDuration } from '../../../../../shared/native-chat/transcript/native-chat-turn-status'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { sayNativeChatSubagentGroupTranslated as say } from './native-chat-subagent-group-words-text'
import { sayNativeChatSessionOptionTranslated as sayOption } from '../session/options/controls/native-chat-session-option-labels-text'

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
export function SubagentElapsed({
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

/** Each entry opens its subagent's own view. */
export function NativeChatSubagentEntries({
  agents,
  onOpen,
  className
}: {
  agents: readonly NativeChatSubagentEntry[]
  onOpen?: (agentId: string) => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ul className={cn('space-y-0.5', className)}>
      {agents.map((agent) => {
        const state = normalizeSubagentState(agent.state)
        const detail = subagentEntryDetail(agent)
        const runsOn = subagentEntryRunsOn(agent, sayOption)
        const entry = (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <StatusDot state={state} pulsing={state === 'working'} />
              <span
                className={cn(
                  'min-w-0 truncate font-sans text-sm',
                  state === 'idle' ? 'text-chat-foreground-faint' : 'text-chat-foreground'
                )}
              >
                {agent.label}
              </span>
              {runsOn ? (
                <span className="min-w-0 shrink truncate rounded-full border border-border px-1.5 font-sans text-3xs text-chat-foreground-faint">
                  {runsOn}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-sans text-xs tabular-nums text-chat-foreground-faint">
                {subagentStateLabel(state, 1, 1, say)}
                {typeof agent.tokens === 'number'
                  ? ` · ${formatSubagentTokens(agent.tokens)}`
                  : null}
              </span>
            </span>
            {detail ? (
              <span className="truncate pl-3 font-sans text-xs text-chat-foreground-faint">
                {detail}
              </span>
            ) : null}
          </span>
        )
        return (
          <li key={agent.id} data-native-chat-subagent-entry={agent.id}>
            <SubagentEntryPreview agent={agent} state={state} detail={detail} runsOn={runsOn}>
              {onOpen === undefined ? (
                <div className="flex items-start gap-1.5 py-0.5">{entry}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpen(agent.id)}
                  className="group/subagent-entry flex w-full items-start gap-1.5 rounded-md py-0.5 text-left hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {entry}
                  <span className="sr-only">
                    {t('components.native-chat.subagents.open', 'Open subagent')}
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="mt-1 size-3.5 shrink-0 text-chat-foreground-faint opacity-0 transition-opacity group-hover/subagent-entry:opacity-100 motion-reduce:transition-none"
                  />
                </button>
              )}
            </SubagentEntryPreview>
          </li>
        )
      })}
    </ul>
  )
}

/** Hover preview: role, model, timing and the longer text the row truncates. */
function SubagentEntryPreview({
  agent,
  state,
  detail,
  runsOn,
  children
}: {
  agent: NativeChatSubagentEntry
  state: NativeChatSubagentState
  detail: string | null
  runsOn: string | null
  children: React.ReactElement
}): React.JSX.Element {
  const role = [subagentRoleLabel(agent.agentType), runsOn].filter(Boolean).join(' · ')
  const text =
    state === 'working' && agent.operation
      ? detail
      : subagentMessageText(agent.lastMessage ?? '') || null
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="top" align="start" variant="workspace-details" className="w-72">
        <div className="space-y-1">
          <div className="truncate text-sm font-medium text-foreground">{agent.label}</div>
          {role ? <div className="truncate text-muted-foreground">{role}</div> : null}
          <div className="tabular-nums text-muted-foreground">
            {subagentStateLabel(state, 1, 1, say)}
            {agent.startedAt !== undefined ? (
              <>
                {' · '}
                <SubagentElapsed
                  startedAt={agent.startedAt}
                  settledAt={agent.settledAt ?? null}
                  counting={state === 'working'}
                />
              </>
            ) : null}
            {typeof agent.tokens === 'number' ? ` · ${formatSubagentTokens(agent.tokens)}` : null}
          </div>
          {text ? (
            <p className="line-clamp-6 whitespace-pre-wrap break-words pt-1 text-foreground">
              {text}
            </p>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

/** Trust journal child states: children outlive their spawning turn, and only host/provider settlement proves lost contact. */
export function NativeChatSubagentRun({
  block,
  disclosureId,
  onOpenSubagent
}: {
  block: NativeChatSubagentGroupBlock
  /** Remembers the reader's open/closed choice past this row's lifetime. */
  disclosureId?: string
  onOpenSubagent?: (agentId: string) => void
}): React.JSX.Element | null {
  const agents = block.agents
  // Not memoized: its words follow the reader's language, which can change under the same roster.
  const header = nativeChatSubagentGroupHeader(agents, say)
  // The list shows while any child works, until the reader says otherwise.
  const { open, setOpen } = useNativeChatDisclosure(
    disclosureId === undefined ? undefined : `subagent-roster:${disclosureId}:${block.groupId}`,
    header.working
  )
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
        <NativeChatSubagentEntries agents={agents} onOpen={onOpenSubagent} className="mt-1" />
      ) : null}
    </div>
  )
}
