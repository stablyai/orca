import { ArrowLeftRight, RotateCcw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { formatUsageLimitResetClock } from '../../../../shared/agent-session/failures/agent-session-usage-limit'
import type { NativeChatBotCardValues } from '../../../../shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { NativeChatEventRow } from './messages/events/NativeChatEventRow'
import {
  NATIVE_CHAT_INLINE_NAME,
  NATIVE_CHAT_ROW_SHARE
} from './messages/events/native-chat-inline-chip'

type BackupSwitch = NativeChatBotCardValues['botBackupModelSwitch']

function modelDisplay(agent: string, model?: string): string {
  const agentName = tuiAgentDisplayName(agent) ?? agent
  return model ? `${agentName} · ${model}` : agentName
}

/** Quiet inline transcript row announcing a bot failover to a backup model or return to primary. */
export function NativeChatBotBackupSwitchCard({
  switched,
  timestamp
}: {
  switched: BackupSwitch
  timestamp: number | null
}): React.JSX.Element {
  const t = useTranslate()
  const targetLabel = modelDisplay(switched.toAgent, switched.toModel)
  const fromLabel = modelDisplay(switched.fromAgent, switched.fromModel)
  const toPrimary = switched.direction === 'to-primary'
  const reset =
    !toPrimary && switched.resetsAt !== undefined
      ? formatUsageLimitResetClock(switched.resetsAt)
      : null
  const lead = toPrimary
    ? t('components.native-chat.botBackupSwitch.returnedLead', 'Returned to')
    : t('components.native-chat.botBackupSwitch.switchedLead', 'Switched to backup')
  const detail = toPrimary
    ? t('components.native-chat.botBackupSwitch.returnedDetail', 'after usage limit reset')
    : reset
      ? t(
          'components.native-chat.botBackupSwitch.switchedDetailReset',
          'while {{from}} is at limit · resets {{time}}',
          { from: fromLabel, time: reset }
        )
      : t(
          'components.native-chat.botBackupSwitch.switchedDetail',
          'while {{from}} is at its usage limit',
          { from: fromLabel }
        )
  return (
    <NativeChatEventRow
      icon={
        toPrimary ? (
          <RotateCcw aria-hidden className="size-3.5" />
        ) : (
          <ArrowLeftRight aria-hidden className="size-3.5" />
        )
      }
      timestamp={timestamp}
    >
      <span className="shrink-0">{lead}</span>
      <span className={NATIVE_CHAT_INLINE_NAME} title={targetLabel}>
        {targetLabel}
      </span>
      <span className={NATIVE_CHAT_ROW_SHARE} title={detail}>
        · {detail}
      </span>
    </NativeChatEventRow>
  )
}
