import { useNativeChatChildNavigation } from '../native-chat-child-navigation'
import { Bot } from 'lucide-react'
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
import {
  sayNativeChatSubagentGroupTranslated as say,
  sayNativeChatSubagentGroupWith
} from './native-chat-subagent-group-words-text'
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
  onOpen,
  stateLabel,
  entryDetail
}: {
  agent: NativeChatSubagentEntry
  disclosureKey?: string
  onOpen?: (agentId: string) => void
  /** The caller's word for its state, e.g. a worker still starting. */
  stateLabel?: string
  entryDetail?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const navigation = useNativeChatChildNavigation()
  const state = normalizeSubagentState(agent.state)
  const details = subagentDetails(agent)
  const open = onOpen
    ? () => onOpen(agent.id)
    : navigation
      ? () => navigation.open({ agentId: agent.id, label: agent.label })
      : null
  return (
    <NativeChatEventRow
      icon={<Bot aria-hidden className="size-3.5" />}
      badge={state === 'working' ? 'running' : state === 'failed' ? 'failed' : null}
      label={stateLabel ? `${agent.label}, ${stateLabel}` : agent.label}
      action={
        open ? (
          <NativeChatEventOpenButton
            name={t('components.native-chat.backgroundTasks.openAgent', 'Open {{value0}}', {
              value0: agent.label
            })}
            onOpen={open}
          />
        ) : null
      }
      timestamp={agent.startedAt ?? null}
      disclosureKey={disclosureKey}
      details={
        details || entryDetail ? (
          <>
            {entryDetail}
            {details?.text ? <p>{details.text}</p> : null}
            {details?.result ? (
              <NativeChatMarkdown
                content={details.result}
                variant="document"
                renderCodeBlock={NativeChatCodeBlock}
                className="text-sm"
              />
            ) : null}
            {details?.facts ? (
              <p className="text-xs text-chat-foreground-faint">{details.facts}</p>
            ) : null}
          </>
        ) : null
      }
    >
      <span className="text-chat-foreground">{agent.label}</span>
      {stateLabel ? <span> · {stateLabel}</span> : null}
    </NativeChatEventRow>
  )
}

/** A turn's subagents under one summary row, one row each once opened; a lone subagent is its own row.
 *  Trust journal child states: children outlive their spawning turn, and only host/provider
 *  settlement proves lost contact. */
export function NativeChatSubagentRun({
  block,
  disclosureId,
  onOpenSubagent,
  stateLabels,
  entryDetails
}: {
  block: NativeChatSubagentGroupBlock
  /** Remembers the reader's open/closed choice past this row's lifetime. */
  disclosureId?: string
  onOpenSubagent?: (agentId: string) => void
  stateLabels?: ReadonlyMap<string, string>
  entryDetails?: ReadonlyMap<string, React.ReactNode>
}): React.JSX.Element | null {
  // `t` changes with the UI language and its catalogs, so the derived words follow them.
  const t = useTranslate()
  const header = nativeChatSubagentGroupHeader(block.agents, sayNativeChatSubagentGroupWith(t))
  if (header.total === 0) {
    return null
  }
  if (header.total === 1) {
    // One row either way, and its name says more than "1 subagent".
    return (
      <NativeChatSubagentRows
        {...{ block, disclosureId, stateLabels, entryDetails }}
        onOpen={onOpenSubagent}
      />
    )
  }
  const { working, headline, verdict, alertState, alert, clockStartedAt } = header
  const summary = alert === null ? verdict : `${verdict} +${alert}`
  return (
    // Closed until the reader opens it: a turn can start many subagents, and the reply matters more.
    <NativeChatEventRow
      icon={<Bot aria-hidden className="size-3.5" />}
      badge={
        working ? 'running' : (alertState ?? header.verdictState) === 'failed' ? 'failed' : null
      }
      label={[headline, summary, header.tokens].filter(Boolean).join(', ')}
      disclosureKey={
        disclosureId === undefined ? undefined : `subagent-roster:${disclosureId}:${block.groupId}`
      }
      detailsAreRows
      details={
        <NativeChatSubagentRows
          {...{ block, disclosureId, stateLabels, entryDetails }}
          onOpen={onOpenSubagent}
        />
      }
    >
      <span className="text-chat-foreground">{headline}</span>
      <span className="tabular-nums">
        {` · ${summary}`}
        {clockStartedAt !== null ? (
          <>
            {' · '}
            <SubagentElapsed
              startedAt={clockStartedAt}
              settledAt={header.settledAt}
              counting={working}
            />
          </>
        ) : null}
        {header.tokens !== null ? ` · ${header.tokens}` : null}
      </span>
    </NativeChatEventRow>
  )
}

function NativeChatSubagentRows({
  block,
  disclosureId,
  onOpen,
  stateLabels,
  entryDetails
}: {
  block: NativeChatSubagentGroupBlock
  disclosureId?: string
  onOpen?: (agentId: string) => void
  stateLabels?: ReadonlyMap<string, string>
  entryDetails?: ReadonlyMap<string, React.ReactNode>
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
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
          stateLabel={stateLabels?.get(agent.id)}
          entryDetail={entryDetails?.get(agent.id)}
        />
      ))}
    </div>
  )
}
