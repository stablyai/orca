import { useId } from 'react'
import { MessageSquare } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../../shared/bot-types'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from '../automation-page-parts'
import { botResultsPlace } from '../../../../../shared/automation-bot-target'
import {
  botResultsToChoice,
  botResultsToOf,
  withBotResultsPlace,
  type BotResultsToChoice
} from '../../../../../shared/automations/bot-automation-target-edit'
import { botTargetChatTitle } from './automation-bot-runs-in-chat'

type AutomationBotTargetFieldsProps = {
  target: AutomationBotTarget
  bot: Pick<Bot, 'name' | 'slack' | 'linear'> | null
  /** Only Slack, GitHub or Linear events start it, so each run has a thread to answer in. */
  hasEventThread: boolean
  /** This computer's Orca Cloud binds an event's run to its thread. */
  threadReplies: boolean
  /** Shown after Runs in, which decides whether a run can pick its own agent. */
  agentField?: React.ReactNode
  resultsOnly?: boolean
  onChange: (target: AutomationBotTarget) => void
}

const RUNS_IN_SAVED_CHAT = 'saved-chat'

/** Where a bot automation's runs happen and where their results go. */
export function AutomationBotTargetFields({
  target,
  bot,
  hasEventThread,
  threadReplies,
  agentField,
  resultsOnly = false,
  onChange
}: AutomationBotTargetFieldsProps): React.JSX.Element {
  const t = useTranslate()
  const threadReady = threadReplies && hasEventThread && target.runsIn === 'new'
  const botName = bot?.name ?? ''
  const chatLabel = t('automations.botTarget.chat', "{{name}}'s Chat", { name: botName })
  const choice = botResultsToChoice(target.resultsTo)
  const posted = typeof target.resultsTo === 'object' ? target.resultsTo : null
  const reactId = useId()
  return (
    <div className="flex flex-col gap-4">
      {resultsOnly ? null : (
        <>
          <Field
            labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
            label={t('automations.botTarget.runsIn', 'Runs in')}
          >
            <Select
              value={target.chat ? RUNS_IN_SAVED_CHAT : target.runsIn}
              onValueChange={(next: AutomationBotTarget['runsIn'] | typeof RUNS_IN_SAVED_CHAT) => {
                if (next !== RUNS_IN_SAVED_CHAT) {
                  // A run in a chat stays on that chat's agent, so its own agent goes.
                  const { agentSetup, ...rest } = target
                  onChange({
                    ...rest,
                    runsIn: next,
                    chat: undefined,
                    ...(next === 'new' && agentSetup ? { agentSetup } : {})
                  })
                }
              }}
            >
              <SelectTrigger className="w-full" wrap>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
                <SelectItem value="new">
                  {t('automations.botTarget.runsInNew', 'A new conversation each time')}
                </SelectItem>
                <SelectItem value="chat">{chatLabel}</SelectItem>
                {/* A chat named with --runs-in chat:<id>; only the CLI picks one, so it is offered only once saved. */}
                {target.chat ? (
                  <SelectItem value={RUNS_IN_SAVED_CHAT}>
                    {botTargetChatTitle(target.chat)}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </Field>
          {agentField}
        </>
      )}
      <Field
        labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
        label={t('automations.botTarget.resultsTo', 'Send results to')}
      >
        <Select
          value={choice}
          onValueChange={(next: BotResultsToChoice) =>
            onChange({ ...target, resultsTo: botResultsToOf(next) })
          }
        >
          <SelectTrigger className="w-full" wrap>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
            <SelectItem value="chat">
              <MessageSquare className="size-3.5" />
              {chatLabel}
            </SelectItem>
            {/* A thread answer needs its own conversation each run, and an event that has a thread. */}
            <SelectItem value="thread" disabled={!threadReady && choice !== 'thread'}>
              {threadReady
                ? t('automations.botTarget.resultsToThread', "The event's thread")
                : threadReplies
                  ? t(
                      'automations.botTarget.resultsToThreadNeedsEvents',
                      "The event's thread (only events, new conversation)"
                    )
                  : t(
                      'automations.botTarget.resultsToThreadUnsupported',
                      "The event's thread (Orca Cloud doesn't support this yet)"
                    )}
            </SelectItem>
            {/* A channel post goes through the bot's Slack app, so it needs one. */}
            <SelectItem value="channel" disabled={!bot?.slack && choice !== 'channel'}>
              {bot?.slack || choice === 'channel'
                ? t('automations.botTarget.resultsToChannel', 'A channel')
                : t(
                    'automations.botTarget.resultsToChannelNeedsSlack',
                    'A channel (connect Slack first)'
                  )}
            </SelectItem>
            {/* A comment goes through Orca's Linear app, so the bot must be on Linear. */}
            <SelectItem value="linear" disabled={!bot?.linear && choice !== 'linear'}>
              {bot?.linear || choice === 'linear'
                ? t('automations.botTarget.resultsToLinear', 'A Linear issue')
                : t(
                    'automations.botTarget.resultsToLinearNeedsLinear',
                    'A Linear issue (connect Linear first)'
                  )}
            </SelectItem>
            <SelectItem value="none">
              {t('automations.botTarget.resultsToNone', 'Nowhere')}
            </SelectItem>
          </SelectContent>
        </Select>
        {posted ? (
          <Input
            value={botResultsPlace(posted)}
            placeholder={
              choice === 'channel'
                ? t('automations.botTarget.channelPlaceholder', '#channel or a Slack link')
                : t(
                    'automations.botTarget.linearIssuePlaceholder',
                    'Issue key (e.g. ENG-123) or a Linear link'
                  )
            }
            aria-label={
              choice === 'channel'
                ? t('automations.botTarget.channelLabel', 'Channel')
                : t('automations.botTarget.linearIssueLabel', 'Linear issue')
            }
            onChange={(event) =>
              onChange({ ...target, resultsTo: withBotResultsPlace(posted, event.target.value) })
            }
          />
        ) : null}
        {/* A run in the Chat itself already left its result there for the bot. */}
        {choice === 'chat' && target.runsIn === 'new' ? (
          <div className="mt-1 flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={reactId} className="text-sm">
                {t('automations.botTarget.letBotReact', 'Let {{name}} react', {
                  name: botName
                })}
              </label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'automations.botTarget.letBotReactHelp',
                  'Each result starts a turn so {{name}} can act on it.',
                  { name: botName }
                )}
              </p>
            </div>
            <Switch
              id={reactId}
              checked={target.letBotReact === true}
              onCheckedChange={(letBotReact) => onChange({ ...target, letBotReact })}
            />
          </div>
        ) : null}
      </Field>
    </div>
  )
}
