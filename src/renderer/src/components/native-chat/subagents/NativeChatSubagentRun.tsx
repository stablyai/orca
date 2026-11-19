import { Bot } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/lib/window-activity/use-now'
import { formatSubagentTokens } from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
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
import { sayNativeChatSubagentGroupTranslated as say } from './native-chat-subagent-group-words-text'
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

/** A turn's subagents, one row each. Trust journal child states: children outlive their spawning
 *  turn, and only host/provider settlement proves lost contact. */
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
  if (block.agents.length === 0) {
    return null
  }
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
          onOpen={onOpenSubagent}
        />
      ))}
    </div>
  )
}
