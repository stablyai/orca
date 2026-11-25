// A bot automation's When and Results fields, shared by the page's editor sidebar and the bot
// panel's in-place section editors so both edit the same draft the same way.
import { useTranslate } from '@/i18n/use-translate'
import { useBotThreadReplies } from '@/lib/bot-catalog'
import { isValidAutomationSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-parsing'
import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../../shared/bot-types'
import { botEventsHaveThreads } from '../../../../../shared/automations/bot-automation-target-edit'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from '../automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationBotAgentField } from './AutomationBotAgentField'
import { AutomationBotEventsField } from './AutomationBotEventsField'
import { AutomationBotTargetFields } from './AutomationBotTargetFields'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'

type DraftChange = (updater: (current: AutomationDraft) => AutomationDraft) => void

/** When it runs: the cadence picker, then its events, which change only by chatting with the bot. */
export function AutomationBotWhenFields({
  draft,
  label,
  labelHidden,
  onDraftChange,
  askInChat
}: {
  draft: AutomationDraft
  label: string
  /** The host already titles the section. */
  labelHidden?: boolean
  onDraftChange: DraftChange
  /** Drafts a sentence into the bot's chat; null when the bot is gone. */
  askInChat: ((sentence: string) => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const saved = draft.savedBotAutomation
  return (
    <>
      <Field
        className="mb-4"
        labelClassName={labelHidden ? 'sr-only' : AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
        label={label}
      >
        <AutomationSchedulePicker
          draft={draft}
          validateAdvancedSchedule={isValidAutomationSchedule}
          onDraftChange={onDraftChange}
          onSetUpEvents={
            askInChat
              ? () =>
                  askInChat(
                    saved
                      ? t(
                          'automations.botEvents.addDraft',
                          'Change the automation “{{name}}” so it also runs when ',
                          { name: saved.name }
                        )
                      : t('automations.botEvents.newDraft', 'Set up an automation that runs when ')
                  )
              : undefined
          }
        />
      </Field>
      {saved?.on.length ? (
        <AutomationBotEventsField
          triggers={saved.on}
          onEditInChat={
            askInChat
              ? () =>
                  askInChat(
                    t('automations.botEvents.editDraft', 'Change the automation “{{name}}”: ', {
                      name: saved.name
                    })
                  )
              : undefined
          }
        />
      ) : null}
    </>
  )
}

/** Where its runs happen and where results go, with the run's own agent when it may pick one. */
export function AutomationBotResultsFields({
  draft,
  target,
  bot,
  onDraftChange,
  resultsOnly = false
}: {
  draft: AutomationDraft
  target: AutomationBotTarget
  bot: Bot | null
  resultsOnly?: boolean
  onDraftChange: DraftChange
}): React.JSX.Element {
  const threadReplies = useBotThreadReplies(bot?.hostId ?? null)
  const saved = draft.savedBotAutomation
  const setTarget = (next: AutomationBotTarget): void =>
    onDraftChange((current) => ({ ...current, bot: next }))
  return (
    <AutomationBotTargetFields
      target={target}
      bot={bot}
      resultsOnly={resultsOnly}
      agentField={
        bot ? <AutomationBotAgentField target={target} bot={bot} onChange={setTarget} /> : null
      }
      threadReplies={threadReplies}
      hasEventThread={botEventsHaveThreads(draft.eventsOnly === true, saved?.on ?? [])}
      onChange={setTarget}
    />
  )
}
