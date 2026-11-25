import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/class-names'
import { callBotRpc } from '@/lib/bot-hosts'
import { openBotAutomation } from '@/components/bots/bot-automation-open'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { useBotActivity } from '@/components/bots/use-bot-activity'
import { botErrorMessage, botRefusalText } from '@/components/bots/bot-presentation'
import { structuredAgentSessionTargetPlace } from '@/components/native-chat/pane/ownership/use-structured-agent-session-host-label'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { AgentSessionRefusalReference } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AutomationRunMessage } from '../../../../../shared/automations/automation-run-message'
import {
  automationRunAccess,
  automationRunEventCopyText,
  automationRunEventLink,
  automationRunQuoteAuthor,
  type AutomationRunResend,
  type AutomationRunRowState,
  type AutomationRunWording
} from '../../../../../shared/automations/automation-run-row-words'
import { useNativeChatVisualOwner } from '../media/visuals/native-chat-visual-owner'
import { useNativeChatLinkClick } from '../links/actions/native-chat-link-click-context'
import { NativeChatAutomationRunInstructions } from './NativeChatAutomationRunInstructions'
import { RUN_LINK_BUTTON } from './automation-run-link-button'
import { ROW_HEADING, ROW_NOTE } from './NativeChatAutomationRowFrame'
import { NativeChatMessageTimestamp } from '../messages/rows/NativeChatMessageTimestamp'
import type { MergedRunFailure } from '../../../../../shared/native-chat/transcript/events/native-chat-event-plan'

const HEADING = ROW_HEADING
const NOTE = ROW_NOTE

/** Copies its text and says so briefly, like the row's copy button. */
function CopyTextButton({ text, label }: { text: string; label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      className={RUN_LINK_BUTTON}
      onClick={() => {
        void window.api.ui.writeClipboardText(text).catch(() => undefined)
      }}
    >
      {label}
    </button>
  )
}

/** Sends a run that couldn't start once more; a wait is deleted once its run starts, so only a wait's
 *  run offers it. Says Sent again after. */
export function NativeChatAutomationSendAgain({
  run,
  resend,
  wording
}: {
  run: AutomationRunMessage
  resend: AutomationRunResend
  wording: AutomationRunWording
}): React.JSX.Element | null {
  const { say } = wording
  const owner = useNativeChatVisualOwner()
  const bot = useBotForWorkspace(owner?.worktreeId ?? null)
  const [sending, setSending] = useState<'idle' | 'busy' | 'sent'>(
    resend === 'sent' ? 'sent' : 'idle'
  )
  if (resend === 'none' || run.wait === undefined || !bot || !owner) {
    return null
  }
  if (sending === 'sent' || resend === 'sent') {
    return <span className="text-xs text-chat-foreground-faint">{say('sentAgain')}</span>
  }
  return (
    <button
      type="button"
      className={RUN_LINK_BUTTON}
      disabled={sending === 'busy'}
      onClick={() => {
        setSending('busy')
        void callBotRpc(bot, 'bots.sendRunAgain', {
          botId: bot.id,
          sessionId: owner.sessionId,
          runId: run.runId
        })
          .then(() => setSending('sent'))
          .catch((error: unknown) => {
            setSending('idle')
            toast.error(botErrorMessage(error))
          })
      }}
    >
      {say('sendAgain')}
    </button>
  )
}

function RunActions({
  run,
  state,
  instructions,
  copyEvent,
  wording
}: {
  run: AutomationRunMessage
  state: AutomationRunRowState
  instructions: string
  copyEvent: string | null
  wording: AutomationRunWording
}): React.JSX.Element | null {
  const { say } = wording
  const owner = useNativeChatVisualOwner()
  const bot = useBotForWorkspace(owner?.worktreeId ?? null)
  const exists = useBotActivity(bot).automations.some(
    (row) => row.automation.id === run.automation.id
  )
  const openOn = state === 'not-started' && exists ? bot?.hostId : undefined
  if (!openOn && !instructions && !copyEvent) {
    return null
  }
  return (
    <div className="mt-2 flex flex-wrap gap-3.5">
      {openOn ? (
        <button
          type="button"
          className={RUN_LINK_BUTTON}
          onClick={() => openBotAutomation(openOn, run.automation.id, run.runId)}
        >
          {say('openAutomation')}
        </button>
      ) : null}
      {instructions ? <CopyTextButton text={instructions} label={say('copyInstructions')} /> : null}
      {copyEvent ? <CopyTextButton text={copyEvent} label={say('copyEvent')} /> : null}
    </div>
  )
}

function RunEvent({
  run,
  facts,
  wording
}: {
  run: AutomationRunMessage
  facts: string
  wording: AutomationRunWording
}): React.JSX.Element | null {
  const { say } = wording
  const onLinkClick = useNativeChatLinkClick()
  const { event } = run
  const link = event ? automationRunEventLink(event, say) : null
  const access = event ? automationRunAccess(event, say) : null
  if (!facts && !event?.text) {
    return null
  }
  return (
    <>
      <h4 className={HEADING}>{say('event')}</h4>
      {facts ? (
        <div className={cn(NOTE, 'flex flex-wrap items-center gap-1.5')}>
          <span>{facts}</span>
          {link ? (
            <>
              <span aria-hidden>·</span>
              <a
                href={link.url}
                className={RUN_LINK_BUTTON}
                onClick={(clickEvent) => onLinkClick?.(clickEvent, link.url)}
              >
                {link.label}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </>
          ) : null}
        </div>
      ) : null}
      {event?.text ? (
        <>
          {/* Provenance first, so a long quote can't push it out of view. */}
          <p className={cn(NOTE, 'mt-2 mb-0.5')}>{say('external')}</p>
          <blockquote className="my-0.5 border-l-2 border-border py-0.5 pl-2.5 whitespace-pre-wrap text-chat-foreground [overflow-wrap:anywhere] select-text">
            <cite className={cn(NOTE, 'mb-0.5 block not-italic whitespace-normal')}>
              {automationRunQuoteAuthor(event, say)}
            </cite>
            {event.text}
          </blockquote>
          {event.textShortened ? <div className={NOTE}>{say('shortened')}</div> : null}
          {access ? <div className={NOTE}>{access}</div> : null}
        </>
      ) : null}
    </>
  )
}

/** The send's error, or why its chat was refused, naming the bot's host as this reader does. */
function StartError({
  error,
  refusal
}: {
  error: string
  refusal?: AgentSessionRefusalReference
}): React.JSX.Element {
  // The transcript's own runtime ran the refused start; it calls itself this computer.
  const owner = useNativeChatVisualOwner()
  const t = useTranslate()
  const hostName = useAppStore((state) =>
    owner ? structuredAgentSessionTargetPlace(state, owner.target, t) : undefined
  )
  return (
    <div className="rounded-md border border-chat-inline-code-border bg-chat-inline-code-surface px-2 py-1 font-mono text-xs text-chat-foreground [overflow-wrap:anywhere] select-text">
      {refusal ? botRefusalText(refusal, hostName) : error}
    </div>
  )
}

/** The opened run: the recorded error, the saved instructions, the event, and what to do next. */
export function NativeChatAutomationRunBody({
  messageId,
  run,
  state,
  instructions,
  facts,
  error,
  refusal,
  earlierFailures,
  wording,
  findQuery
}: {
  messageId: string
  run: AutomationRunMessage
  state: AutomationRunRowState
  instructions: string
  facts: string
  error?: string
  refusal?: AgentSessionRefusalReference
  /** Earlier tries of this run that couldn't start, newest first. */
  earlierFailures?: readonly MergedRunFailure[]
  wording: AutomationRunWording
  /** The Find bar's query: instructions holding it show whole. */
  findQuery: string
}): React.JSX.Element {
  const { say } = wording
  const copyEvent = run.event?.text ? automationRunEventCopyText(facts, run.event, say) : null
  return (
    <div>
      {error ? (
        <>
          <h4 className={HEADING}>{say('startError')}</h4>
          <StartError error={error} refusal={refusal} />
        </>
      ) : null}
      {instructions ? (
        <>
          <h4 className={HEADING}>{say('instructions')}</h4>
          <NativeChatAutomationRunInstructions
            messageId={messageId}
            instructions={instructions}
            findQuery={findQuery}
            showAll={say('showAll')}
            showLess={say('showLess')}
          />
        </>
      ) : null}
      <RunEvent run={run} facts={facts} wording={wording} />
      {earlierFailures?.map((failure) => (
        <div key={failure.id}>
          <h4 className={cn(HEADING, 'flex items-center gap-1')}>
            {say('couldNotStart')}
            <NativeChatMessageTimestamp timestamp={failure.timestamp} />
          </h4>
          <StartError error={failure.error} refusal={failure.refusal} />
        </div>
      ))}
      <RunActions
        run={run}
        state={state}
        instructions={instructions}
        copyEvent={copyEvent}
        wording={wording}
      />
    </div>
  )
}
