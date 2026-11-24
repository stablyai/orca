import { useState } from 'react'
import { Bot as BotIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { isSameBot, ownBotHost } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useBotHostLabels } from '@/components/bots/use-bot-host-label'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { pairedAskSenderName } from '@/components/bots/BotPairedAskNeedRow'
import { usePairedServerCardsForChat } from '@/components/bots/use-paired-server-asks'
import { NativeChatApprovalCard } from '../prompts/NativeChatApprovalCard'
import { NativeChatPromptPill } from '../composer/editor/NativeChatPromptPill'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { PairedServerAskCard } from '../../../../../shared/rpc-contract/paired-server-asks-params'

type Decision = 'once' | 'always' | 'deny'
const DECISIONS: readonly string[] = ['once', 'always', 'deny']
const isDecision = (value: string): value is Decision => DECISIONS.includes(value)

/** Asks this computer holds from agents in this paired server's chat, pinned above its composer as
 *  permission cards: title and buttons only, since the message shows on the asker's activity line. */
export function NativeChatPairedServerAskStack({
  target,
  party
}: {
  target: RuntimeClientTarget
  /** The chat's own address, as the server names the root chat an ask came from. */
  party: string | null
}): React.JSX.Element | null {
  const cards = usePairedServerCardsForChat(
    target.kind === 'environment' ? target.environmentId : null,
    party
  )
  const [submitting, setSubmitting] = useState<ReadonlyMap<string, Decision>>(new Map())
  const decide = (card: PairedServerAskCard, decision: Decision): void => {
    setSubmitting((current) => new Map(current).set(card.messageId, decision))
    // On this computer's own Orca, which holds the card; the list drops it once answered anywhere.
    callRuntimeRpc(ownBotHost().target, 'pairedServerAsks.decide', {
      messageId: card.messageId,
      decision
    })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
      .finally(() =>
        setSubmitting((current) => {
          const next = new Map(current)
          next.delete(card.messageId)
          return next
        })
      )
  }
  if (cards.length === 0) {
    return null
  }
  return (
    <div
      className="scrollbar-sleek max-h-[40%] min-h-0 shrink-[4] overflow-y-auto"
      data-native-chat-paired-server-asks=""
    >
      {cards.map((card) => (
        <div key={card.messageId} data-native-chat-paired-server-ask={card.messageId}>
          <PairedServerAskCardView
            card={card}
            submitting={submitting.get(card.messageId)}
            onDecide={(decision) => decide(card, decision)}
          />
        </div>
      ))}
    </div>
  )
}

export function PairedServerAskCardView({
  card,
  submitting,
  onDecide
}: {
  card: PairedServerAskCard
  submitting: Decision | undefined
  onDecide: (decision: Decision) => void
}): React.JSX.Element {
  const t = useTranslate()
  const serverHost = toRuntimeExecutionHostId(card.environmentId)
  const bots = useBots()
  const asker = bots.find(
    (bot) =>
      card.from.sender?.bot !== undefined &&
      isSameBot(bot, { hostId: serverHost, id: card.from.sender.bot.id })
  )
  const local = bots.find((bot) =>
    isSameBot(bot, { hostId: LOCAL_EXECUTION_HOST_ID, id: card.botId })
  )
  // This computer's own name for the server: what it reports about itself could name another.
  const label = useBotHostLabels([serverHost]).get(serverHost)
  const server =
    card.serverName ||
    label ||
    t('components.native-chat.pairedServerAsk.thisServer', 'this server')
  const from = pairedAskSenderName(card)
  const to = local?.name ?? card.botId
  const pill = (label: string, avatar: React.ReactNode) => (
    <NativeChatPromptPill icon={BotIcon} avatar={avatar} label={label} selected={false} />
  )
  const title = t(
    'components.native-chat.pairedServerAsk.title',
    '{{from}} wants to message {{to}} on this computer',
    { from, to }
  )
  return (
    <NativeChatApprovalCard
      approval={{
        title,
        options: [
          {
            label: t('components.native-chat.pairedServerAsk.once', 'Allow once'),
            send: 'once'
          },
          {
            label: t('components.native-chat.pairedServerAsk.always', 'Always allow {{server}}', {
              server
            }),
            send: 'always'
          },
          { label: t('components.native-chat.pairedServerAsk.deny', 'Deny'), send: 'deny' }
        ]
      }}
      titleContent={
        <Trans
          i18n={i18n}
          defaults={t(
            'components.native-chat.pairedServerAsk.titlePills',
            '<from>{{from}}</from> wants to message <to>{{to}}</to> on this computer'
          )}
          values={{ from, to }}
          components={{
            from: pill(from, asker ? <BotAvatar bot={asker} className="size-full" /> : undefined),
            to: pill(to, local ? <BotAvatar bot={local} className="size-full" /> : undefined)
          }}
        />
      }
      onChoose={(option) => {
        if (isDecision(option)) {
          onDecide(option)
        }
      }}
      isSubmitting={submitting !== undefined}
      submittingOption={submitting}
      placement="stacked"
      wrapOptions
    />
  )
}
