import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { openBotAutomation } from '@/components/bots/bot-automation-open'
import { botAutomationWhen } from '@/components/bots/bot-automation-when'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { launchModelLabel } from '@/components/agent/AgentLaunchPicker'
import { WebhookCopyUrlButton } from '@/components/bots/webhooks/WebhookCopyUrlButton'
import { webhookResultsTo, webhookUnknownBotName } from '@/components/bots/webhooks/webhook-copy'
import { hookIdOfRule } from '../../../../../shared/connector-webhook-contract'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import {
  automationRowAccessibleName,
  automationRowMark
} from '../../../../../shared/automations/automation-chat-row'
import { useAutomationRunWording } from './automation-run-wording'
import {
  useNativeChatVisualOwner,
  type NativeChatVisualOwner
} from '../media/visuals/native-chat-visual-owner'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { NativeChatAutomationCardDetails } from '../NativeChatAutomationCardDetails'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { requestNativeChatComposerFocus } from '../composer/focus/native-chat-composer-focus-intent'
import {
  NativeChatAutomationRowBody,
  NativeChatAutomationRowFrame,
  ROW_NOTE
} from './NativeChatAutomationRowFrame'
import { RUN_LINK_BUTTON } from './automation-run-link-button'

// Every automation card in a chat shares this prefix, so opening one closes the rest.
const AUTOMATION_CARD_DISCLOSURE = 'automation-card:'

type AutomationSaved = NonNullable<NativeChatMessage['automationSaved']>

function results(saved: AutomationSaved): string {
  return saved.resultsTo === undefined
    ? translate('components.native-chat.automationSaved.resultsInRuns', 'results in each run')
    : webhookResultsTo(saved.resultsTo)
}

/** "on Codex · gpt-6.1-terra" for a bot automation on its own agent; nothing on the bot's. */
function ownAgent(saved: AutomationSaved): string | null {
  const setup = saved.agentSetup
  if (!setup) {
    return null
  }
  const name = [botAgentLabel(setup.agent), launchModelLabel(setup.agent, setup.launch?.model)]
    .filter(Boolean)
    .join(' · ')
  return translate('components.native-chat.automationSaved.onAgent', 'on {{name}}', { name })
}

/** The saved automation's hook, if it has one; the URL itself is never in the transcript. */
function savedHookId(saved: AutomationSaved): string | null {
  const rule = saved.automation.on?.find((trigger) => trigger.source === 'webhook')
  return rule ? hookIdOfRule(rule.id) : null
}

function CopyWebhookUrl({
  target,
  hookId,
  worktreeId
}: {
  target: RuntimeClientTarget
  hookId: string
  worktreeId: string
}): React.JSX.Element {
  const botName = useBotForWorkspace(worktreeId)?.name ?? webhookUnknownBotName()
  return <WebhookCopyUrlButton target={target} hookId={hookId} botName={botName} />
}

/** Adds "Change “<name>” so that " to this chat's unsent message, with the caret after it. */
function draftChangeInChat(owner: NativeChatVisualOwner, name: string): void {
  requestNativeChatComposerFocus(owner.tabId ?? structuredAgentSessionTabId(owner.sessionId), {
    append: translate(
      'components.native-chat.automationSaved.editDraft',
      'Change “{{name}}” so that ',
      {
        name
      }
    )
  })
}

/** The automation this chat's agent created or edited, as its row: what it saved; opens in place to
 *  its live settings. */
export function NativeChatAutomationSavedRow({
  saved,
  timestamp,
  disclosureId
}: {
  saved: AutomationSaved
  timestamp: number | null
  /** The transcript row's id, so the row stays open while it scrolls out of view. */
  disclosureId?: string
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
  const wording = useAutomationRunWording(automation)
  const hookId = savedHookId(saved)
  const when = botAutomationWhen(automation)
  const facts = [
    when,
    ownAgent(saved),
    results(saved),
    ...(automation.enabled ? [] : [t('components.native-chat.automationSaved.paused', 'paused')])
  ].filter(Boolean)
  const label = wording.say(saved.change === 'updated' ? 'updatedAutomation' : 'createdAutomation')
  const status = automation.enabled ? when : wording.say('paused')
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
      <NativeChatAutomationRowFrame
        mark={automationRowMark(automation)}
        label={label}
        name={automation.name}
        status={status}
        accessibleName={automationRowAccessibleName(
          {
            label,
            name: automation.name,
            status,
            time: timestamp === null ? null : wording.formatTime(timestamp)
          },
          wording.say
        )}
        timestamp={timestamp}
        open={open}
        onToggle={() => setOpen(!open)}
        toggleRef={toggle}
        action={
          hookId && owner ? (
            <div className="relative shrink-0">
              <CopyWebhookUrl target={owner.target} hookId={hookId} worktreeId={owner.worktreeId} />
            </div>
          ) : null
        }
      >
        {(ids) => (
          <NativeChatAutomationRowBody ids={ids} timestamp={timestamp}>
            <p className={ROW_NOTE}>{facts.join(' · ')}</p>
            {hookId && owner ? (
              <p className={ROW_NOTE}>
                {t(
                  'components.native-chat.automationSaved.webhookHint',
                  'Point your service at this URL'
                )}
              </p>
            ) : null}
            {open ? (
              <NativeChatAutomationCardDetails
                automationId={automation.id}
                environmentId={
                  owner?.target.kind === 'environment' ? owner.target.environmentId : null
                }
                onEditInChat={owner ? () => draftChangeInChat(owner, automation.name) : null}
              />
            ) : null}
            <div className="mt-2">
              <button
                type="button"
                className={RUN_LINK_BUTTON}
                onClick={() => openBotAutomation(automation.id, null)}
              >
                {wording.say('openAutomation')}
              </button>
            </div>
          </NativeChatAutomationRowBody>
        )}
      </NativeChatAutomationRowFrame>
    </div>
  )
}
