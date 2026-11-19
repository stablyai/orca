import { Bot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/lib/window-activity/use-now'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader
} from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import {
  subagentEntryDetail,
  subagentEntryRunsOn,
  subagentRoleLabel
} from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-entry-detail'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock
} from '../../../../../shared/native-chat/native-chat-types'
import { formatNativeChatDuration } from '../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'
import { NativeChatEventRow } from '../messages/events/NativeChatEventRow'
import { NativeChatEventOpenButton } from '../messages/events/NativeChatEventOpenButton'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { sayNativeChatSubagentGroupTranslated as say } from './native-chat-subagent-group-words-text'
import { NativeChatSubagentStatusIcon } from './NativeChatSubagentStatusIcon'
import { sayNativeChatSessionOptionTranslated as sayOption } from '../session/options/controls/native-chat-session-option-labels-text'

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

/** What it is doing, or once settled its result, then its role, where it runs and its tokens; null when it has none. */
function subagentDetails(
  agent: NativeChatSubagentEntry
): { text: string; result: string; facts: string } | null {
  const working = normalizeSubagentState(agent.state) === 'working'
  const text = working ? (subagentEntryDetail(agent) ?? '') : ''
  const result = working ? '' : (agent.lastMessage?.trim() ?? '')
  const facts = [
    subagentRoleLabel(agent.agentType),
    subagentEntryRunsOn(agent, sayOption),
    typeof agent.tokens === 'number'
      ? say('tokens', { value0: formatSubagentTokens(agent.tokens) })
      : null
  ]
    .filter(Boolean)
    .join(' · ')
  return text || result || facts ? { text, result, facts } : null
}

/** One subagent as a status row: the agent mark with a spinner while it works and a red ✕ when it
 *  failed, its name, then its open icon. Opens to what it is doing or its result. */
function NativeChatSubagentRow({
  agent,
  disclosureKey,
  onOpen
}: {
  agent: NativeChatSubagentEntry
  disclosureKey?: string
  onOpen?: (agentId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = normalizeSubagentState(agent.state)
  const details = subagentDetails(agent)
  return (
    <NativeChatEventRow
      icon={<Bot aria-hidden className="size-3.5" />}
      badge={state === 'working' ? 'running' : state === 'failed' ? 'failed' : null}
      label={agent.label}
      action={
        onOpen ? (
          <NativeChatEventOpenButton
            name={t('components.native-chat.backgroundTasks.openAgent', 'Open {{value0}}', {
              value0: agent.label
            })}
            onOpen={() => onOpen(agent.id)}
          />
        ) : null
      }
      timestamp={agent.startedAt ?? null}
      disclosureKey={disclosureKey}
      details={
        details ? (
          <>
            {details.text ? <p>{details.text}</p> : null}
            {details.result ? (
              <NativeChatMarkdown
                content={details.result}
                variant="document"
                renderCodeBlock={NativeChatCodeBlock}
                className="text-sm"
              />
            ) : null}
            {details.facts ? (
              <p className="text-xs text-chat-foreground-faint">{details.facts}</p>
            ) : null}
          </>
        ) : null
      }
    >
      <span className="text-chat-foreground">{agent.label}</span>
    </NativeChatEventRow>
  )
}

/** A turn's subagents under one summary row, one row each once opened. Trust journal child states:
 *  children outlive their spawning turn, and only host/provider settlement proves lost contact. */
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
  // Not memoized: its words follow the reader's language, which can change under the same roster.
  const header = nativeChatSubagentGroupHeader(block.agents, say)
  // Closed until the reader opens it: a turn can start many subagents, and the reply matters more.
  const { open, setOpen } = useNativeChatDisclosure(
    disclosureId === undefined ? undefined : `subagent-roster:${disclosureId}:${block.groupId}`,
    false
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
        <span className="flex size-4 shrink-0 items-center justify-center text-chat-foreground-faint">
          <Bot aria-hidden="true" className="size-3.5" />
        </span>
        <NativeChatSubagentStatusIcon state={alertState ?? verdictState} />
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
        <NativeChatSubagentRows block={block} disclosureId={disclosureId} onOpen={onOpenSubagent} />
      ) : null}
    </div>
  )
}

function NativeChatSubagentRows({
  block,
  disclosureId,
  onOpen
}: {
  block: NativeChatSubagentGroupBlock
  disclosureId?: string
  onOpen?: (agentId: string) => void
}): React.JSX.Element {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {block.agents.map((agent) => (
        <NativeChatSubagentRow
          key={agent.id}
          agent={agent}
          disclosureKey={
            disclosureId === undefined
              ? undefined
              : `subagent:${disclosureId}:${block.groupId}:${agent.id}`
          }
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}
