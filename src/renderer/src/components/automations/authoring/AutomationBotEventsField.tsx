import { MessageSquare, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  isConnectorTrigger,
  isWebhookTrigger,
  type AutomationEventTrigger
} from '../../../../../shared/automation-event-triggers'
import { isGoogleTrigger } from '../../../../../shared/automation-google-triggers'
import { eventLabel } from '../../bots/bot-automation-when'
import {
  googleTriggerPhrases,
  peoplePhrase,
  placesPhrase,
  subjectPhrase
} from '../../bots/bot-automation-event-places'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from '../automation-page-parts'

/** "On a Slack message · in a thread in #orca · from Nora · containing “deploy”": one event, by name. */
export function eventTriggerLine(trigger: AutomationEventTrigger): string {
  const rule = isConnectorTrigger(trigger) ? trigger : null
  const webhook = isWebhookTrigger(trigger) ? trigger : null
  const contains = rule?.textContains ?? webhook?.textContains
  return [
    eventLabel(trigger),
    ...(rule
      ? [placesPhrase(rule), subjectPhrase(rule), peoplePhrase(rule)].flatMap((part) => part ?? [])
      : webhook?.subject
        ? [
            translate('automations.botEvents.subject', 'on {{subject}}', {
              subject: webhook.subject
            })
          ]
        : []),
    ...(isGoogleTrigger(trigger) ? googleTriggerPhrases(trigger) : []),
    ...(rule?.onOwnerMessage
      ? [translate('automations.botEvents.onOwnerMessage', 'on your messages')]
      : []),
    ...(contains
      ? [
          translate('automations.botEvents.contains', 'containing “{{text}}”', {
            text: contains
          })
        ]
      : [])
  ].join(' · ')
}

/** A bot automation's events, read-only: they are set up and changed by chatting with the bot. */
export function AutomationBotEventsField({
  triggers,
  onEditInChat
}: {
  triggers: readonly AutomationEventTrigger[]
  /** Absent when the bot is gone: nothing can change them then. */
  onEditInChat?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Field
      className="mb-4"
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={t('automations.botEvents.label', 'Events')}
    >
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1.5">
          {triggers.map((trigger) => (
            <li key={trigger.id} className="flex items-start gap-2 text-sm">
              <Zap className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 break-words">{eventTriggerLine(trigger)}</span>
            </li>
          ))}
        </ul>
        {onEditInChat ? (
          <Button variant="outline" size="sm" className="self-start" onClick={onEditInChat}>
            <MessageSquare />
            {t('automations.botEvents.editInChat', 'Edit in chat')}
          </Button>
        ) : null}
      </div>
    </Field>
  )
}
