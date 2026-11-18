import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAutomationCardDetails } from './use-automation-card-details'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'
import { captureAutomationReceiptSource, openReceiptAutomation } from './automation-receipt-client'
import { readAutomationReceiptFacts } from '../../../../shared/automations/automation-receipt-facts'
import { automationReceiptStartDetails } from '../../../../shared/automations/automation-receipt-summary'
import { receiptInstant, receiptStartLabel, receiptZoneName } from './automation-receipt-copy'
import { NativeChatAutomationCurrentDetails } from './NativeChatAutomationCurrentDetails'

/** An opened automation card: its live settings, newest runs and actions, read from its host. */
export function NativeChatAutomationCardDetails({
  saved,
  timestamp,
  owner,
  itemId,
  shortened,
  onEditInChat
}: {
  saved: NonNullable<NativeChatMessage['automationSaved']>
  timestamp: number | null
  owner: NativeChatVisualOwner | null
  itemId?: string
  shortened: boolean
  onEditInChat: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const [source] = useState(() =>
    shortened ? null : captureAutomationReceiptSource(owner, itemId, saved)
  )
  const { details, controller } = useAutomationCardDetails(source)
  const facts = shortened ? undefined : readAutomationReceiptFacts(saved.receiptFacts)
  const zone =
    facts &&
    !('unavailable' in facts) &&
    facts.zone.kind === 'effective-at-save' &&
    receiptZoneName(facts.zone.iana)
      ? facts.zone.iana
      : null
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const savedScopes = automationReceiptStartDetails(
    saved.automation,
    saved.receiptFacts,
    shortened
  ).map(({ start, showLabel }, index) => {
    if (start.kind !== 'event') {
      return { id: `${start.kind}:${index}`, text: receiptStartLabel(start) }
    }
    const conditions =
      start.extra?.additionalConditions === 'present'
        ? t('components.native-chat.automationSaved.savedFilters', 'With saved filters')
        : start.extra?.additionalConditions === 'none'
          ? t(
              'components.native-chat.automationSaved.noSavedFilters',
              'No additional conditions when saved.'
            )
          : t(
              'components.native-chat.automationSaved.filtersUnknown',
              'Saved conditions weren’t recorded'
            )
    const google = start.extra?.google
    const account =
      google?.account.kind === 'named'
        ? google.account.value
        : google
          ? t('components.native-chat.automationSaved.onlyHostAccount', 'The host’s only account')
          : null
    const calendar =
      google?.kind === 'calendar'
        ? google.calendar === 'primary'
          ? t('components.native-chat.automationSaved.primaryCalendar', 'Primary calendar')
          : t('components.native-chat.automationSaved.otherCalendar', 'A saved calendar')
        : null
    return {
      id: `${start.trigger.id}:${index}`,
      text: [showLabel ? receiptStartLabel(start) : null, account, calendar, conditions]
        .filter(Boolean)
        .join(' · ')
    }
  })
  const note =
    details.acknowledgement === 'deleted'
      ? t('components.native-chat.automationSaved.deleteAcknowledged', 'Automation deleted')
      : details.status === 'missing'
        ? saved.automation.once
          ? t(
              'components.native-chat.automationSaved.waitMissing',
              'This wait no longer exists. Its outcome wasn’t recorded here.'
            )
          : t(
              'components.native-chat.automationSaved.definitionMissing',
              'This automation wasn’t found. The reason is unknown.'
            )
        : details.status === 'unverified' || details.status === 'mismatch'
          ? t(
              'components.native-chat.automationSaved.originUnknown',
              'Saved receipt only. Its original automation could not be verified on this host.'
            )
          : t('components.native-chat.automationSaved.loadFailed', 'Couldn’t read this automation')
  return (
    <div className="@container mt-3 border-t border-border pt-3">
      {timestamp !== null ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {zone && zone !== viewerZone
            ? t(
                'components.native-chat.automationSaved.savedBothZones',
                'Saved {{savedTime}} · your time: {{viewerTime}}',
                {
                  savedTime: receiptInstant(timestamp, zone),
                  viewerTime: receiptInstant(timestamp, viewerZone)
                }
              )
            : t('components.native-chat.automationSaved.savedAt', 'Saved {{time}}', {
                time: receiptInstant(timestamp)
              })}
        </p>
      ) : null}
      {!zone ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {t(
            'components.native-chat.automationSaved.zoneNotRecorded',
            "Time zone wasn't recorded; showing your local time"
          )}
        </p>
      ) : null}
      {savedScopes.length ? (
        <div className="mb-3 text-xs text-muted-foreground">
          {savedScopes.map((scope) => (
            <p key={scope.id} className="break-words">
              {scope.text}
            </p>
          ))}
        </div>
      ) : null}
      {details.status === 'loading' ? (
        <Loader2
          className="size-4 animate-spin text-muted-foreground"
          aria-label={t('components.native-chat.automationSaved.loading', 'Loading')}
        />
      ) : details.status === 'ready' && source ? (
        <NativeChatAutomationCurrentDetails
          automation={details.automation}
          runs={details.runs}
          source={source}
          owner={details.owner}
          controller={controller}
          effectiveZone={details.effectiveZone}
          onEditInChat={onEditInChat}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{note}</p>
      )}
      {details.acknowledgement && details.status === 'loading' ? (
        <p className="text-sm text-muted-foreground">{note}</p>
      ) : null}
      {details.status === 'ready' && source ? (
        <Button
          type="button"
          variant="link"
          size="inlineText"
          className="mt-3"
          onClick={() => {
            if (!openReceiptAutomation(source, details.automation, details.owner, null)) {
              toast.message(
                t(
                  'components.native-chat.automationSaved.routeUnavailable',
                  'Open this automation from its host’s Automations page.'
                )
              )
            }
          }}
        >
          {t('components.native-chat.automationSaved.openFullPage', 'Open page')}
        </Button>
      ) : null}
    </div>
  )
}
