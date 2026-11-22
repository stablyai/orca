import type { Bot } from '../../../../shared/bot-types'
import type { PairedServerAskCard } from '../../../../shared/rpc-contract/paired-server-asks-params'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { parseOrcaSessionAddress } from '../../../../shared/agent-session/identity/orca-session-address'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { isSameBot } from '@/lib/bot-hosts'
import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'
import { openBotSession } from './bot-session-open'
import { useBotHostLabel } from './use-bot-host-label'
import { NeedRow } from './BotNeedRow'

/** Who on the paired server asks: its agent's bot name, else its own name, else how its mail is signed. */
export function pairedAskSenderName(card: PairedServerAskCard): string {
  return card.from.sender?.bot?.name ?? card.from.sender?.name ?? card.from.label
}

/** An agent on a paired server wants to message `bot`: the permission row, opening the server chat
 *  the card is answered in. */
export function PairedAskNeedRow({
  bot,
  card
}: {
  bot: Bot
  card: PairedServerAskCard
}): React.JSX.Element {
  const t = useTranslate()
  const serverHost = toRuntimeExecutionHostId(card.environmentId)
  const hostLabel = useBotHostLabel(serverHost)
  const askerBotId = card.from.sender?.bot?.id
  const asker = useBots(askerBotId !== undefined).find(
    (entry) => askerBotId !== undefined && isSameBot(entry, { hostId: serverHost, id: askerBotId })
  )
  const sessionId = parseOrcaSessionAddress(card.rootSession)
  const open = asker && sessionId ? () => openBotSession(asker, sessionId) : null
  const name = bot.name
  return (
    <NeedRow
      kind="approval"
      title={t('bots.needs.pairedAsk', '{{from}} wants to message {{name}}', {
        from: pairedAskSenderName(card),
        name
      })}
      host={hostLabel ? <WorktreeHostContextBadge label={hostLabel} /> : null}
      detail={t('bots.needs.pairedAskDetail', 'Permission · Message {{name}}', { name })}
      action={open ? { label: t('bots.needs.open', 'Open'), onOpen: open } : null}
    />
  )
}
