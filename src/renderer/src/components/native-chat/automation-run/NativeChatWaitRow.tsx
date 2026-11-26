import { useMemo, useState } from 'react'
import { useNow } from '@/lib/window-activity/use-now'
import { toast } from 'sonner'
import { botTarget } from '@/lib/bot-hosts'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { useBotActivity, useBotActivityRead } from '@/components/bots/use-bot-activity'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import { botAutomationWhen } from '@/components/bots/bot-automation-when'
import { openBotAutomation } from '@/components/bots/bot-automation-open'
import { deleteAutomationForTarget } from '@/components/automations/hosts/automation-host-client'
import type { Bot } from '../../../../../shared/bot-types'
import type { AutomationOnce, WaitEnding } from '../../../../../shared/automation-once'
import type { BotAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import {
  automationRowMark,
  waitRowLabel,
  waitRowState,
  waitRowStatus,
  waitRowThen,
  waitRowTime,
  waitHostRead,
  type WaitRowState
} from '../../../../../shared/automations/automation-chat-row'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { useNativeChatVisualOwner } from '../media/visuals/native-chat-visual-owner'
import { useAutomationRunWording } from './automation-run-wording'
import { RUN_LINK_BUTTON } from './automation-run-link-button'
import { NativeChatAutomationRowFrame, ROW_HEADING, ROW_NOTE } from './NativeChatAutomationRowFrame'

/** Open automation while the host lists it; Cancel while it still waits, deleting it unrun. */
function WaitActions({
  bot,
  automationId,
  label
}: {
  bot: Bot
  automationId: string
  label: { open: string; cancel: string }
}): React.JSX.Element | null {
  const activity = useBotActivity(bot)
  const exists = activity.automations.some((row) => row.automation.id === automationId)
  const waiting = activity.waits?.some((row) => row.automation.id === automationId)
  const [busy, setBusy] = useState(false)
  if (!exists && !waiting) {
    return null
  }
  return (
    <div className="mt-2 flex flex-wrap gap-3.5">
      {exists ? (
        <button
          type="button"
          className={RUN_LINK_BUTTON}
          onClick={() => openBotAutomation(bot.hostId, automationId, null)}
        >
          {label.open}
        </button>
      ) : null}
      {waiting ? (
        <button
          type="button"
          className={RUN_LINK_BUTTON}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void deleteAutomationForTarget({ id: automationId, runContext: null }, botTarget(bot))
              .catch((error: unknown) => toast.error(botErrorMessage(error)))
              .finally(() => setBusy(false))
          }}
        >
          {label.cancel}
        </button>
      ) : null}
    </div>
  )
}

function WaitRow({
  messageId,
  automation,
  once,
  state,
  madeAt,
  bot
}: {
  messageId: string
  automation: BotAutomationFacts
  once: AutomationOnce | undefined
  state: WaitRowState
  madeAt: number | null
  bot: Bot | null
}): React.JSX.Element {
  const wording = useAutomationRunWording(automation)
  const { say } = wording
  const { open, setOpen } = useNativeChatDisclosure(`automation-row:${messageId}`, false)
  const label = waitRowLabel(state, say)
  const status = waitRowStatus(automation, state, wording)
  const timestamp = waitRowTime(state, madeAt)
  const when = botAutomationWhen(automation)
  return (
    <NativeChatAutomationRowFrame
      mark={automationRowMark(automation)}
      lead={label}
      name={automation.name}
      status={status}
      timestamp={timestamp}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <>
        {when ? (
          <>
            <h4 className={ROW_HEADING}>{say('waitsFor')}</h4>
            <div className="text-card-foreground">{when}</div>
          </>
        ) : null}
        {once && state.kind === 'waiting' ? (
          <>
            <h4 className={ROW_HEADING}>{say('thenLine')}</h4>
            <div className={ROW_NOTE}>{waitRowThen(automation, once, wording)}</div>
          </>
        ) : null}
        {bot ? (
          <WaitActions
            bot={bot}
            automationId={automation.id}
            label={{ open: say('openAutomation'), cancel: say('cancel') }}
          />
        ) : null}
      </>
    </NativeChatAutomationRowFrame>
  )
}

/** A wait the bot started, as its row: Waiting, then Cancelled when cancelled while it waited, or
 *  Wait over once it ran or its deadline passed. */
export function NativeChatWaitRow({
  messageId,
  automation,
  once,
  ended,
  endedOn,
  timestamp
}: {
  messageId: string
  automation: BotAutomationFacts
  once: AutomationOnce
  /** How it ended, when its run or card is in this chat. */
  ended?: WaitEnding
  /** The rules it had when it ended, which an edit may have changed. */
  endedOn?: BotAutomationFacts['on']
  timestamp: number | null
}): React.JSX.Element {
  const owner = useNativeChatVisualOwner()
  const bot = useBotForWorkspace(owner?.worktreeId ?? null)
  // A minute clock only while a deadline may still pass here, so the row turns Wait over then.
  const now = useNow(60_000, !ended && once.by !== undefined)
  // Its host's waits, so a wait that ran or went in another chat stops reading Waiting here.
  const activity = useBotActivityRead(ended ? null : bot)
  const host = useMemo(() => (bot ? waitHostRead(bot.id, activity) : null), [bot, activity])
  return (
    <WaitRow
      messageId={messageId}
      automation={automation}
      once={once}
      state={
        waitRowState(
          {
            automationSaved: { automation },
            savedWaitEnded: ended,
            savedWaitEndedOn: endedOn,
            timestamp
          },
          bot?.cancelledWaits,
          now,
          host
        ) ?? {
          kind: 'waiting',
          once
        }
      }
      madeAt={timestamp}
      bot={bot}
    />
  )
}

/** How a wait ended, from a host that wrote it apart from its run: event, deadline, or 30 days. */
export function NativeChatWaitEndedRow({
  messageId,
  ended,
  timestamp
}: {
  messageId: string
  ended: { automation: BotAutomationFacts; ending: WaitEnding }
  timestamp: number | null
}): React.JSX.Element {
  const owner = useNativeChatVisualOwner()
  const bot = useBotForWorkspace(owner?.worktreeId ?? null)
  return (
    <WaitRow
      messageId={messageId}
      automation={ended.automation}
      once={ended.automation.once}
      state={{ kind: 'ended', ending: ended.ending }}
      madeAt={timestamp}
      bot={bot}
    />
  )
}
