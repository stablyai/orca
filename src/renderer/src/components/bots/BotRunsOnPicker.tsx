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
import { BotAgentLaunchPicker, type BotAgentSetup } from './BotAgentLaunchPicker'
import {
  botCreateHostBlockedHint,
  useServerUpdatable,
  type BotCreateHostChoice
} from './bot-create-hosts'
import { BotComputerPicker } from './BotComputerPicker'
import { botAgentLabel, botFolderDisplay } from './bot-presentation'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'

/** Where a new bot's home goes, named as the runtime names it among `bots` on that computer. */
export function botFolderPreview(
  name: string,
  bots: readonly { name: string }[],
  windows?: boolean
): string {
  return botFolderDisplay(botFolderName(newBotName(name, bots)), windows)
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
  name: string
  /** `row` is a boxed summary row; `caption` a plain centered line with an inline Change. */
  variant?: 'row' | 'caption'
}): React.JSX.Element {
  const t = useTranslate()
  const { host, otherAccount } = hostChoice
  const updatable = useServerUpdatable()
  const hostBots = useHostBots(host.hostId)
  const blockedHint = botCreateHostBlockedHint(
    host,
    Boolean(host.environmentId && updatable(host.environmentId)),
    t
  )
  const chosen = setup.agent
  // What was picked for the agent, as the picker's own trigger names it.
  const picked = [
    setup.launch?.model &&
      (getAgentSessionOptionLaunchCatalog(chosen)?.models.find(
        (model) => model.id === setup.launch?.model
      )?.label ??
        setup.launch.model),
    setup.launch?.options?.effort
  ]
    .filter(Boolean)
    .join(' · ')
  const runsOn = (
    <Trans
      i18n={i18n}
      defaults={
        otherAccount
          ? t('bots.new.runsOnAs', 'Runs on <host/>, as <account/>, with <agent/>')
          : t('bots.new.runsOn', 'Runs on <host/> with <agent/>')
      }
      components={{
        host: <span className="font-medium text-foreground">{host.label}</span>,
        account: <span className="font-medium text-foreground">{otherAccount}</span>,
        agent: (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <AgentIcon agent={chosen} size={variant === 'caption' ? 12 : 14} />
            {botAgentLabel(chosen)}
          </span>
        )
      }}
    />
  )
  const controls = (
    <>
      <div className="space-y-1">
        <Label>{t('bots.new.computer', 'Computer')}</Label>
        <BotComputerPicker hostChoice={hostChoice} />
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
        <BotAgentLaunchPicker
          model={model}
          choices={choices.length ? choices : [chosen]}
          value={setup}
          onChange={onSetupChange}
        />
      </div>
      <p className="text-2xs text-muted-foreground">
        {t('bots.new.folder', 'Folder: {{path}}', {
          path: botFolderPreview(name, hostBots, host.windows)
        })}
      </p>
    </>
  )
  if (variant === 'caption') {
    return (
      <Collapsible>
        {/* The whole line opens the section; flex keeps the agent's icon on the text's center line. */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group mx-auto flex flex-wrap items-center justify-center gap-x-1 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {runsOn}
            {picked ? <span>({picked})</span> : null}
            <span aria-hidden>·</span>
            <span className="underline decoration-current/40 underline-offset-2 group-hover:decoration-current">
              {t('bots.new.change', 'Change')}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent animation="height">
          <div className="mt-3 space-y-3 border-t border-border pt-3">{controls}</div>
        </CollapsibleContent>
      </Collapsible>
    )
  }
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
