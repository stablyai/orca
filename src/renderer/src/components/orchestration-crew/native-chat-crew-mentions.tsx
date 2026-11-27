import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  OrchestrationCrewRow,
  OrchestrationCrewSnapshot
} from '../../../../shared/orchestration/orchestration-crew'
import type { OrchestrationAgentReference } from '../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import type { NativeChatRoomMention } from '../native-chat/composer/native-chat-composer-types'
import { crewPartyStatus } from './crew-party-status'

const AGENT_VALUE = 'crew-agent:'

/** An `@` menu value that names a crew agent rather than a bot or a file. */
export function isCrewAgentMentionValue(value: string): boolean {
  return value.startsWith(AGENT_VALUE)
}

/** The row's recorded state, as the host joined it. */
export function crewRowStatus(row: OrchestrationCrewRow) {
  return crewPartyStatus({
    dot: undefined,
    status: row.status,
    taskFailed: row.task?.state === 'failed'
  })
}

export type CrewAgentMentions = {
  mentions: readonly NativeChatRoomMention[]
  references: ReadonlyMap<string, OrchestrationAgentReference>
}

export const NO_CREW_AGENT_MENTIONS: CrewAgentMentions = Object.freeze({
  mentions: [],
  references: new Map()
})

/** The agents this chat's strip lists that mail can reach: its manager, workers and peers. Subagents have no address. */
export function crewAgentMentions(
  rows: OrchestrationCrewSnapshot | null | undefined,
  hostKey: string,
  t: Translate = translate
): CrewAgentMentions {
  if (!rows) {
    return NO_CREW_AGENT_MENTIONS
  }
  const seen = new Set<string>()
  const mentions: NativeChatRoomMention[] = []
  const references = new Map<string, OrchestrationAgentReference>()
  const sections = [
    [rows.sections.managedBy, t('components.orchestrationCrew.managedBy', 'Managed by')],
    [rows.sections.managing, null]
  ] as const
  for (const [section, fallback] of sections) {
    for (const row of section) {
      if (!row.sendAddress || seen.has(row.partyKey)) {
        continue
      }
      seen.add(row.partyKey)
      const key = `${AGENT_VALUE}${row.partyKey}`
      references.set(key, {
        label: row.label,
        address: row.sendAddress,
        hostKey,
        agentType: row.agentKind
      })
      mentions.push({
        key,
        name: row.label,
        icon: <AgentTypeIcon agentType={row.agentKind} size={14} className="mt-0.5 size-3.5" />,
        noteIcon: <StatusIndicator status={crewRowStatus(row)} showTooltip={false} />,
        note: row.task?.title ?? fallback ?? undefined
      })
    }
  }
  return { mentions, references }
}

export function rankNativeChatCrewMentions(
  members: readonly { name: string; detail?: string; key?: string }[],
  query: string
): string[] {
  const needle = query.toLocaleLowerCase()
  const has = (text: string | undefined) => text?.toLocaleLowerCase().includes(needle) === true
  const starts = members.filter((member) => member.name.toLocaleLowerCase().startsWith(needle))
  const named = members.filter((member) => !starts.includes(member) && has(member.name))
  const described = members.filter(
    (member) => !starts.includes(member) && !named.includes(member) && has(member.detail)
  )
  return [...starts, ...named, ...described].map((member) => member.key ?? member.name)
}
