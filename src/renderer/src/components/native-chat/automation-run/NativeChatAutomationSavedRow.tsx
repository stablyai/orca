import { useContext, useId, useRef } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/class-names'
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
import {
  NativeChatMessageTimestamp,
  useNativeChatMessageTimeLabel
} from '../messages/rows/NativeChatMessageTimestamp'
import { NativeChatToolRunWindowContext } from '../tools/runs/native-chat-tool-run-window-context'
import { RUN_LINK_BUTTON } from './automation-run-link-button'
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
  const paused = !automation.enabled
  const savedWhen = when
    ? t('components.native-chat.automationSaved.savedWhen', 'Saved: {{when}}', { when })
    : null
  const pausedWord = savedWhen
    ? t('components.native-chat.automationSaved.paused', 'paused')
    : wording.say('paused')
  const time = useNativeChatMessageTimeLabel(timestamp)
  // Find searches drawn, unclipped text: while it has a query the saved facts are drawn whole, as
  // the row did before; the live Details still wait for a real open.
  const { findActive } = useContext(NativeChatToolRunWindowContext)
  const shown = open || findActive
  const detailsId = useId()
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
  const openAutomation = (): void =>
    openBotAutomation(
      getRuntimeTargetHostId(owner?.target ?? { kind: 'local' }),
      automation.id,
      null
    )
  const Chevron = shown ? ChevronUp : ChevronDown
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
      <NativeChatCardFrame className="native-chat-automation-saved">
        <div className="relative flex gap-3">
          {/* The whole header opens Details, as the row did; only Open sits above it. */}
          <button
            ref={toggle}
            type="button"
            aria-expanded={shown}
            aria-controls={shown ? detailsId : undefined}
            aria-label={[label, automation.name, savedWhen, paused ? pausedWord : null, time]
              .filter(Boolean)
              .join(', ')}
            title={automation.name}
            onClick={() => setOpen(!open)}
            className="absolute -inset-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <NativeChatCardAvatar className="native-chat-automation-saved-avatar pointer-events-none">
            <NativeChatAutomationMark
              mark={automationRowMark(automation)}
              className="size-4 text-foreground"
            />
          </NativeChatCardAvatar>
          <div className="pointer-events-none min-w-0 flex-1">
            <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-2xs text-muted-foreground">
              <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
              <NativeChatMessageTimestamp
                timestamp={timestamp}
                className="ml-auto text-2xs text-muted-foreground"
              />
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-end justify-between gap-2">
                <div className="min-w-0">
                  <span
                    className={cn(
                      'block text-sm font-semibold text-foreground',
                      findActive ? '[overflow-wrap:anywhere]' : 'truncate'
                    )}
                  >
                    {automation.name}
                  </span>
                  {savedWhen || paused ? (
                    // A long trigger is cut before "paused", never the other way round.
                    <span className="flex min-w-0 items-end gap-1 text-2xs text-muted-foreground">
                      {savedWhen ? (
                        <span
                          data-saved-when
                          className={cn(
                            'min-w-0 [overflow-wrap:anywhere]',
                            !findActive && 'line-clamp-2'
                          )}
                        >
                          {savedWhen}
                        </span>
                      ) : null}
                      {paused ? (
                        <span data-saved-paused className="shrink-0 whitespace-nowrap">
                          {savedWhen ? `· ${pausedWord}` : pausedWord}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                <Chevron className="mb-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="pointer-events-auto relative"
                aria-label={t('components.native-chat.automationSaved.openNamed', 'Open {{name}}', {
                  name: automation.name
                })}
                onClick={openAutomation}
              >
                {t('components.native-chat.automationSaved.open', 'Open')}
              </Button>
            </div>
          </div>
        </div>
        {shown ? (
          <div
            id={detailsId}
            className="mt-2 ml-11 border-t border-border pt-2 [overflow-wrap:anywhere]"
          >
            <p className={ROW_NOTE}>{facts.join(' · ')}</p>
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
              <button type="button" className={RUN_LINK_BUTTON} onClick={openAutomation}>
                {wording.say('openAutomation')}
              </button>
            </div>
          </div>
        ) : null}
      </NativeChatCardFrame>
    </div>
  )
}
