import { useRef } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { openBotAutomation } from '@/components/bots/bot-automation-open'
import { botAutomationWhen } from '@/components/bots/bot-automation-when'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { launchModelLabel } from '@/components/agent/agent-launch-model-label'
import { webhookResultsTo, webhookUnknownBotName } from '@/components/bots/webhooks/webhook-copy'
import { automationHookId } from '../../../../../shared/automation-event-triggers'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { automationRowMark } from '../../../../../shared/automations/automation-chat-row'
import { useAutomationRunWording } from './automation-run-wording'
import {
  useNativeChatVisualOwner,
  type NativeChatVisualOwner
} from '../media/visuals/native-chat-visual-owner'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { NativeChatAutomationCardDetails } from '../NativeChatAutomationCardDetails'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { requestNativeChatComposerFocus } from '../composer/focus/native-chat-composer-focus-intent'
import { ROW_NOTE } from './NativeChatAutomationRowFrame'
import { NativeChatAutomationMark } from './NativeChatAutomationMark'
import { NativeChatCardAvatar, NativeChatCardFrame } from '../NativeChatCardFrame'
import { NativeChatMessageTimestamp } from '../messages/rows/NativeChatMessageTimestamp'
import { NativeChatExpandable } from '../messages/disclosure/NativeChatExpandable'
import { NativeChatWebhookSetupCard } from './NativeChatWebhookSetupCard'

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

/** The automation this chat's agent created or edited, as a card: its name, the trigger it was saved
 *  with and Open; the disclosure opens in place to its live settings. */
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
  const hookId = automationHookId(automation)
  const botName = useBotForWorkspace(owner?.worktreeId ?? null)?.name ?? webhookUnknownBotName()
  const when = botAutomationWhen(automation)
  const facts = [
    when,
    ownAgent(saved),
    results(saved),
    ...(automation.enabled ? [] : [t('components.native-chat.automationSaved.paused', 'paused')])
  ].filter(Boolean)
  const label = wording.say(saved.change === 'updated' ? 'updatedAutomation' : 'createdAutomation')
  // One folded line: the trigger as saved, and that it was saved paused.
  const saving = [
    when
      ? t('components.native-chat.automationSaved.savedWhen', 'Saved: {{when}}', { when })
      : null,
    automation.enabled ? null : t('components.native-chat.automationSaved.paused', 'paused')
  ]
    .filter(Boolean)
    .join(' · ')
  if (hookId && owner) {
    // Its URL is what the user needs next, so a webhook automation is a card, not a folded row.
    return (
      <NativeChatWebhookSetupCard
        target={owner.target}
        hookId={hookId}
        botName={botName}
        name={automation.name}
      />
    )
  }
  const Chevron = open ? ChevronUp : ChevronDown
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
        className="native-chat-automation-saved"
        headingClassName="mb-0.5 text-2xs"
        avatar={
          <NativeChatCardAvatar className="native-chat-automation-saved-avatar">
            <NativeChatAutomationMark
              mark={automationRowMark(automation)}
              className="size-4 text-foreground"
            />
          </NativeChatCardAvatar>
        }
        heading={label}
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
              <span
                className="block truncate text-sm font-semibold text-foreground"
                title={automation.name}
              >
                {automation.name}
              </span>
              {saving ? (
                <span className="line-clamp-2 text-2xs text-muted-foreground">{saving}</span>
              ) : null}
            </span>
            <Chevron className="mb-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={wording.say('openAutomation')}
            onClick={() =>
              openBotAutomation(
                getRuntimeTargetHostId(owner?.target ?? { kind: 'local' }),
                automation.id,
                null
              )
            }
          >
            {t('components.native-chat.automationSaved.open', 'Open')}
          </Button>
        </div>
        <NativeChatExpandable open={open}>
          {open ? (
            <div className="mt-2 border-t border-border pt-2">
              <p className={ROW_NOTE}>{facts.join(' · ')}</p>
              <NativeChatAutomationCardDetails
                automationId={automation.id}
                environmentId={
                  owner?.target.kind === 'environment' ? owner.target.environmentId : null
                }
                onEditInChat={owner ? () => draftChangeInChat(owner, automation.name) : null}
              />
            </div>
          ) : null}
        </NativeChatExpandable>
      </NativeChatCardFrame>
    </div>
  )
}
