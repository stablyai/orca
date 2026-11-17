import { useRef, useState } from 'react'
import { CalendarClock, ChevronDown, ChevronUp, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { botErrorMessage } from '@/components/bots/bot-presentation'
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
import {
  captureAutomationReceiptSource,
  openReceiptAutomation,
  readAutomationReceipt
} from '../automation-receipt-client'

const AUTOMATION_CARD_DISCLOSURE = 'automation-card:'
type AutomationSaved = NonNullable<NativeChatMessage['automationSaved']>

function draftChangeInChat(owner: NativeChatVisualOwner, name: string): void {
  requestNativeChatComposerFocus(owner.tabId ?? structuredAgentSessionTabId(owner.sessionId), {
    append: translate(
      'components.native-chat.automationSaved.editDraft',
      'Change “{{name}}” so that ',
      { name }
    )
  })
}

async function openCardAutomation(
  owner: NativeChatVisualOwner | null,
  itemId: string | undefined,
  saved: AutomationSaved,
  shortened: boolean
): Promise<boolean> {
  const source = shortened ? null : captureAutomationReceiptSource(owner, itemId, saved)
  if (!source) {
    return false
  }
  const result = await readAutomationReceipt(source)
  return (
    result.status === 'ready' &&
    openReceiptAutomation(source, result.automation, result.owner, null)
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
  const [opening, setOpening] = useState(false)
  const Icon = hasAutomationSchedule(automation) ? CalendarClock : Zap
  const Chevron = open ? ChevronUp : ChevronDown
  const openFull = (): void => {
    setOpening(true)
    void openCardAutomation(owner, disclosureId, saved, shortened)
      .then((opened) => {
        if (!opened) {
          setOpen(true)
        }
      })
      .catch((error: unknown) => {
        toast.error(botErrorMessage(error))
        setOpen(true)
      })
      .finally(() => setOpening(false))
  }
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
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
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 items-end justify-between gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-foreground">
                {automation.name}
              </span>
              <span className="block text-2xs text-muted-foreground">
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
