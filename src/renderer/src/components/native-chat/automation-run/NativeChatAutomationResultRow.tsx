import { useTranscriptBot } from '@/components/bots/bot-transcript-bot'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { useTranslation } from 'react-i18next'
import { useTranslate } from '@/i18n/use-translate'
import { openBotAutomation } from '@/components/bots/bot-automation-open'
import { useBotActivity } from '@/components/bots/use-bot-activity'
import {
  AUTOMATION_RESULT_NOTE_COPY as COPY,
  type AutomationResultNote
} from '../../../../../shared/bots/bot-automation-result-note'
import {
  automationRowMark,
  type AutomationRowMark
} from '../../../../../shared/automations/automation-chat-row'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'
import { useNativeChatVisualOwner } from '../media/visuals/native-chat-visual-owner'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { useAutomationRunWording } from './automation-run-wording'
import { RUN_LINK_BUTTON } from './automation-run-link-button'
import { NativeChatAutomationRowFrame, ROW_NOTE } from './NativeChatAutomationRowFrame'

// The note carries no rules; past every schedule, so no schedule is worded.
const NO_RULES = { dtstart: Number.MAX_SAFE_INTEGER, rrule: '' }

/** Its automation's mark while the bot still has it; else what the note recorded. */
function useResultMark(note: AutomationResultNote): AutomationRowMark {
  const owner = useNativeChatVisualOwner()
  const bot = useTranscriptBot(owner)
  const row = useBotActivity(bot).automations.find(
    (entry) => entry.automation.id === note.automationId
  )
  if (row) {
    return automationRowMark(row.automation)
  }
  return note.trigger === 'schedule' ? 'schedule' : 'event'
}

/** An automation run's result in its bot's Chat, as its row; opens into the result. */
export function NativeChatAutomationResultRow({
  note,
  cleared = false
}: {
  note: AutomationResultNote
  /** A later /clear left it unread for good. */
  cleared?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const owner = useNativeChatVisualOwner()
  const bot = useTranscriptBot(owner)
  useTranslation()
  const { say } = useAutomationRunWording(NO_RULES)
  const { open, setOpen } = useNativeChatDisclosure(`automation-result:${note.runId}`, false)
  const finished = note.outcome === 'finished'
  const label = note.trigger === 'schedule' ? say('scheduled') : say('event')
  const status = finished ? say('finished') : say('couldNotFinish')
  return (
    <NativeChatAutomationRowFrame
      mark={useResultMark(note)}
      lead={label}
      name={note.automationName}
      status={status}
      failed={!finished}
      timestamp={note.at}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <>
        <NativeChatMarkdown
          content={note.result}
          variant="document"
          renderCodeBlock={NativeChatCodeBlock}
          className="text-sm text-card-foreground"
        />
        <p className={`${ROW_NOTE} mt-2`}>
          {note.readWith !== undefined
            ? t('components.native-chat.automationResult.read', COPY.read, {
                name: note.botName
              })
            : cleared
              ? t('components.native-chat.automationResult.cleared', COPY.cleared, {
                  name: note.botName
                })
              : t('components.native-chat.automationResult.notRead', COPY.notRead, {
                  name: note.botName
                })}
        </p>
        <div className="mt-2">
          <button
            type="button"
            className={RUN_LINK_BUTTON}
            onClick={() =>
              openBotAutomation({
                bot,
                owner: owner?.automationOwner ?? null,
                automationId: note.automationId,
                runId: note.runId,
                hostId: owner ? getRuntimeTargetHostId(owner.target) : null
              })
            }
          >
            {t('components.native-chat.automationResult.openRun', COPY.openRun)}
          </button>
        </div>
      </>
    </NativeChatAutomationRowFrame>
  )
}
