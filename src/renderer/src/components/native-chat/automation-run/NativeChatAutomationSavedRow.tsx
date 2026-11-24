import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CalendarClock, ChevronDown, ChevronUp, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import { webhookUnknownBotName } from '@/components/bots/webhooks/webhook-copy'
import type { WebhookHostTarget } from '@/components/bots/webhooks/webhook-host-client'
import { readHostBots, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { hasAutomationSchedule } from '../../../../../shared/automation-event-triggers'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatCardAvatar, NativeChatCardFrame } from '../NativeChatCardFrame'
import { NativeChatMessageTimestamp } from '../messages/rows/NativeChatMessageTimestamp'
import {
  useNativeChatVisualOwner,
  type NativeChatVisualOwner
} from '../media/visuals/native-chat-visual-owner'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { NativeChatExpandable } from '../messages/disclosure/NativeChatExpandable'
import { NativeChatAutomationCardDetails } from '../NativeChatAutomationCardDetails'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { requestNativeChatComposerFocus } from '../composer/focus/native-chat-composer-focus-intent'
import { automationReceiptSummary } from '../automation-receipt-copy'
import { openCardAutomation } from '../automation-receipt-client'
import { NativeChatWebhookSetupCard } from './NativeChatWebhookSetupCard'
import {
  useVerifiedReceiptWebhook,
  type VerifiedReceiptWebhook
} from './use-verified-receipt-webhook'

const AUTOMATION_CARD_DISCLOSURE = 'automation-card:'
type AutomationSaved = NonNullable<NativeChatMessage['automationSaved']>

/** The newest folded Open. Any later automation-card gesture makes it stale, so its late reply
 *  cannot expand a card or close one the reader opened meanwhile. */
let pendingCardOpen: AbortController | null = null

function supersedePendingCardOpen(): void {
  pendingCardOpen?.abort()
  pendingCardOpen = null
}

function draftChangeInChat(owner: NativeChatVisualOwner, name: string): void {
  requestNativeChatComposerFocus(owner.tabId ?? structuredAgentSessionTabId(owner.sessionId), {
    append: translate(
      'components.native-chat.automationSaved.editDraft',
      'Change “{{name}}” so that ',
      { name }
    )
  })
}

/** The receipt's own bot, by id on the confirming host, from the catalog as already read: a change
 *  listener only, never the all-host refresh a catalog subscriber starts. Unknown reads as "the bot". */
function useReceiptBotName(target: WebhookHostTarget, botId: string | undefined): string {
  const hostId = getRuntimeTargetHostId(target)
  const name = useSyncExternalStore(subscribeToBotChanges, () =>
    botId ? readHostBots(hostId).find((bot) => bot.id === botId)?.name : undefined
  )
  return name ?? webhookUnknownBotName()
}

function ReceiptWebhookSetupCard({
  webhook,
  name
}: {
  webhook: VerifiedReceiptWebhook
  name: string
}): React.JSX.Element {
  const botName = useReceiptBotName(webhook.target, webhook.botId)
  return (
    <NativeChatWebhookSetupCard
      target={webhook.target}
      hookId={webhook.hookId}
      botName={botName}
      name={name}
    />
  )
}

/** A saved receipt. Only an intentional disclosure or Open acquires current data. */
export function NativeChatAutomationSavedRow({
  saved,
  timestamp,
  disclosureId,
  shortened = false
}: {
  saved: AutomationSaved
  timestamp: number | null
  disclosureId?: string
  shortened?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const owner = useNativeChatVisualOwner()
  const { automation } = saved
  const { open, setOpen } = useNativeChatDisclosure(
    disclosureId === undefined ? undefined : `${AUTOMATION_CARD_DISCLOSURE}${disclosureId}`,
    false,
    AUTOMATION_CARD_DISCLOSURE
  )
  const toggle = useRef<HTMLButtonElement>(null)
  const pendingOpen = useRef<AbortController | null>(null)
  const [opening, setOpening] = useState(false)
  useEffect(
    () => () => {
      // Why: the chat pane's <Activity> runs this when hidden, not only on unmount, and keeps
      // this row's state; release the Open here or it stays disabled after returning.
      pendingOpen.current?.abort()
      pendingOpen.current = null
      setOpening(false)
    },
    []
  )
  const webhook = useVerifiedReceiptWebhook(owner, disclosureId, saved, shortened)
  const Icon = hasAutomationSchedule(automation) ? CalendarClock : Zap
  const Chevron = open ? ChevronUp : ChevronDown
  const choose = (next: boolean): void => {
    supersedePendingCardOpen()
    setOpen(next)
  }
  const openFull = (): void => {
    supersedePendingCardOpen()
    pendingOpen.current?.abort()
    const lifetime = new AbortController()
    pendingCardOpen = lifetime
    pendingOpen.current = lifetime
    setOpening(true)
    // Why: a superseded Open's reply may never come; its row must not stay busy waiting for it.
    lifetime.signal.addEventListener(
      'abort',
      () => {
        if (pendingOpen.current === lifetime) {
          pendingOpen.current = null
          setOpening(false)
        }
      },
      { once: true }
    )
    void openCardAutomation(owner, disclosureId, saved, shortened, lifetime.signal)
      .then((opened) => {
        if (!lifetime.signal.aborted && opened === 'unavailable') {
          setOpen(true)
        }
      })
      .catch((error: unknown) => {
        if (lifetime.signal.aborted) {
          return
        }
        toast.error(botErrorMessage(error))
        setOpen(true)
      })
      .finally(() => {
        if (pendingCardOpen === lifetime) {
          pendingCardOpen = null
        }
        if (pendingOpen.current === lifetime) {
          pendingOpen.current = null
          setOpening(false)
        }
      })
  }
  if (webhook) {
    // Its URL is what the user needs next, so a verified webhook automation is a card, not a
    // folded row. Until verified, Details offers the receipt-bound Copy URL instead.
    return <ReceiptWebhookSetupCard webhook={webhook} name={automation.name} />
  }
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          choose(false)
          toggle.current?.focus()
        }
      }}
    >
      <NativeChatCardFrame
        className="native-chat-automation-receipt shadow-xs"
        headingClassName="mb-0.5 text-2xs font-medium"
        avatar={
          <NativeChatCardAvatar className="native-chat-automation-receipt-avatar">
            <Icon className="size-4 text-foreground" aria-hidden />
          </NativeChatCardAvatar>
        }
        heading={
          saved.change === 'updated'
            ? t('components.native-chat.automationSaved.updated', 'Updated automation')
            : t('components.native-chat.automationSaved.created', 'Created automation')
        }
        trailing={
          <NativeChatMessageTimestamp
            timestamp={timestamp}
            className="text-2xs text-muted-foreground"
          />
        }
      >
        <div className="flex items-end justify-between gap-3">
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            onClick={() => choose(!open)}
            className="flex min-w-0 flex-1 items-end justify-between gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-foreground">
                {automation.name}
              </span>
              <span
                className={cn('text-2xs text-muted-foreground', open ? 'block' : 'line-clamp-2')}
              >
                {automationReceiptSummary(saved, shortened)}
              </span>
            </span>
            <Chevron className="mb-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
          {!open ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={opening}
              onClick={() => void openFull()}
            >
              {t('components.native-chat.automationSaved.open', 'Open')}
            </Button>
          ) : null}
        </div>
        <NativeChatExpandable open={open}>
          {open ? (
            <NativeChatAutomationCardDetails
              saved={saved}
              timestamp={timestamp}
              owner={owner}
              itemId={disclosureId}
              shortened={shortened}
              onEditInChat={owner ? () => draftChangeInChat(owner, automation.name) : null}
            />
          ) : null}
        </NativeChatExpandable>
      </NativeChatCardFrame>
    </div>
  )
}
