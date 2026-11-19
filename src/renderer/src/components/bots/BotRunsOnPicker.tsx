// "Runs on <host> with <agent>": the folded row in New bot and Import from another app.
import React from 'react'
import { Trans } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { type BotAgent, botFolderName, newBotName } from '../../../../shared/bot-types'
import { useHostBots } from '@/lib/bot-catalog'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'
import { launchModelLabel } from '../agent/AgentLaunchPicker'
import { usePickedAgentModel } from '../agent/agent-launch-setup-state'
import { BotAgentLaunchPicker, type BotAgentSetup } from './BotAgentLaunchPicker'
import {
  botCreateHostBlockedHint,
  useServerUpdatable,
  type BotCreateHostChoice
} from './bot-create-hosts'
import { BotComputerPicker } from './BotComputerPicker'
import { botAgentLabel, botFolderDisplay } from './bot-presentation'
import { nativeChatSessionChoiceShortLabel } from '../../../../shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated } from '../native-chat/session/options/controls/native-chat-session-option-labels-text'

/** Where a new bot's home goes, named as the runtime names it among `bots` on that computer. */
export function botFolderPreview(
  name: string,
  bots: readonly { name: string }[],
  windows?: boolean
): string {
  return botFolderDisplay(botFolderName(newBotName(name, bots)), windows)
}

function BotFolderPreview({ name, host }: { name: string; host: BotCreateHostChoice['host'] }) {
  const t = useTranslate()
  const bots = useHostBots(host.hostId)
  return (
    <p className="text-2xs text-muted-foreground">
      {t('bots.new.folder', 'Folder: {{path}}', {
        path: botFolderPreview(name, bots, host.windows)
      })}
    </p>
  )
}

export function BotRunsOnPicker({
  hostChoice,
  setup,
  model,
  choices,
  onSetupChange,
  name,
  variant = 'row'
}: {
  /** The computer it runs on (`useBotCreateHost`). */
  hostChoice: BotCreateHostChoice
  /** The agent, already the first one that computer has, with its model and permissions. */
  setup: BotAgentSetup
  /** The chosen computer's agent menu (`useBotAgentMenu`). */
  model: NewTabAgentMenuModel
  /** The agents that computer has. */
  choices: readonly BotAgent[]
  onSetupChange: (setup: BotAgentSetup) => void
  /** The bot's name, for its folder. */
  name?: string
  /** `row` is a boxed summary row; `caption` puts the two pickers in the sentence. */
  variant?: 'row' | 'caption'
}): React.JSX.Element {
  const t = useTranslate()
  const { host, otherAccount } = hostChoice
  const updatable = useServerUpdatable()
  const blockedHint = botCreateHostBlockedHint(
    host,
    Boolean(host.environmentId && updatable(host.environmentId)),
    t
  )
  const chosen = setup.agent
  const inline = variant === 'caption'
  const modelId = setup.launch?.model
  const listed = usePickedAgentModel(chosen, host.hostId, modelId)
  const effort = setup.launch?.options?.effort
  const picked = [
    listed?.label ?? launchModelLabel(chosen, modelId),
    effort
      ? nativeChatSessionChoiceShortLabel(
          { value: effort, label: effort },
          sayNativeChatSessionOptionTranslated,
          'effort'
        )
      : undefined
  ]
    .filter(Boolean)
    .join(' · ')
  const computerPicker = <BotComputerPicker hostChoice={hostChoice} inline={inline} />
  const agentPicker = (
    <BotAgentLaunchPicker
      key={host.hostId}
      model={model}
      choices={inline || choices.length ? choices : [chosen]}
      value={setup}
      onChange={onSetupChange}
      inline={inline}
    />
  )
  const runsOn = (
    <Trans
      i18n={i18n}
      defaults={
        otherAccount && !inline
          ? t('bots.new.runsOnAs', 'Runs on <host/>, as <account/>, with <agent/>')
          : t('bots.new.runsOn', 'Runs on <host/> with <agent/>')
      }
      components={{
        host: inline ? (
          computerPicker
        ) : (
          <span className="font-medium text-foreground">{host.label}</span>
        ),
        account: (
          <span className="min-w-0 break-all font-medium text-foreground">{otherAccount}</span>
        ),
        agent: inline ? (
          agentPicker
        ) : (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <AgentIcon agent={chosen} size={14} />
            {botAgentLabel(chosen)}
          </span>
        )
      }}
    />
  )
  if (inline) {
    const hint =
      blockedHint ??
      (model.state === 'settled' && !choices.length
        ? t('bots.new.noChatAgents', 'No chat agents available on this computer.')
        : otherAccount
          ? t(
              'bots.new.computerAccountHint',
              'Where the bot runs, signed in to Orca as {{account}}.',
              {
                account: otherAccount
              }
            )
          : null)
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-center gap-1.5 text-center text-xs whitespace-nowrap text-muted-foreground">
          {runsOn}
        </div>
        {picked || hint ? (
          <p className="text-center text-2xs [overflow-wrap:anywhere] text-muted-foreground">
            {picked}
            {hint ? <span className="block">{hint}</span> : null}
          </p>
        ) : null}
      </div>
    )
  }
  const controls = (
    <>
      <div className="space-y-1">
        <Label>{t('bots.new.computer', 'Computer')}</Label>
        {computerPicker}
        <p className="text-2xs text-muted-foreground">
          {blockedHint ??
            (otherAccount
              ? t(
                  'bots.new.computerAccountHint',
                  'Where the bot runs, signed in to Orca as {{account}}.',
                  { account: otherAccount }
                )
              : t('bots.new.computerHint', 'Where the bot runs.'))}
        </p>
      </div>
      <div className="space-y-1">
        <Label>{t('bots.new.agent', 'Agent')}</Label>
        {agentPicker}
      </div>
      <BotFolderPreview name={name ?? ''} host={host} />
    </>
  )
  return (
    <Collapsible>
      <div className="rounded-lg border border-border">
        <CollapsibleTrigger variant="summary">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">{runsOn}</span>
            {/* Its own line, so the pick always shows in the narrow dialog. */}
            {picked ? (
              <span className="truncate text-xs text-muted-foreground">{picked}</span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs">
            {t('bots.new.change', 'Change')}
            <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent animation="height">
          <div className="space-y-3 px-2.5 pt-1 pb-3">{controls}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
