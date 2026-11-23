// Where a new bot runs: Computer and Agent side by side in New bot, or the folded "Runs on <host> with
// <agent>" row in Import from another app.
import React, { useId } from 'react'
import { Trans } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { i18n } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { HostRowIcon } from '@/components/host-picker/host-row-icon'
import { type BotAgent, botFolderName, newBotName } from '../../../../shared/bot-types'
import { useHostBots } from '@/lib/bot-catalog'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'
import { launchModelLabel } from '../agent/AgentLaunchPicker'
import { usePickedAgentModel } from '../agent/agent-launch-setup-state'
import { COMBOBOX_FIELD_SHELL } from '../new-workspace/type-ahead/type-ahead-combobox-styles'
import { BotAgentLaunchPicker, type BotAgentSetup } from './BotAgentLaunchPicker'
import {
  botCreateHostBlockedHint,
  useServerUpdatable,
  type BotCreateHostBlock,
  type BotCreateHostChoice
} from './bot-create-hosts'
import { BotComputerPicker } from './BotComputerPicker'
import { botAgentLabel, botFolderDisplay } from './bot-presentation'
import type { BotPermissionIntent } from './use-bot-agent-setup'
import { nativeChatSessionChoiceShortLabel } from '../../../../shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated } from '../native-chat/session/options/controls/native-chat-session-option-labels-text'

function computerErrorLabel(blocked: BotCreateHostBlock, updatable: boolean, t: Translate): string {
  switch (blocked) {
    case 'offline':
      return t('bots.new.validation.computerOffline', 'Offline')
    case 'no-bots':
      return updatable
        ? t('bots.new.validation.updateOrca', 'Update Orca')
        : t('bots.new.validation.botsUnavailable', 'Bots unavailable')
    case 'needs-server':
      return t('bots.new.hostNeedsServer', 'Needs Orca server')
  }
}

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
  keptPermission,
  onAddHost,
  name,
  showSubmitFeedback = false,
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
  onSetupChange: (setup: BotAgentSetup, permissionPicked?: boolean) => void
  /** A bot from a link: the owner's permission, kept apart from the agent (`useBotAgentSetup`). */
  keptPermission?: BotPermissionIntent
  onAddHost?: (mode: 'ssh' | 'server') => void
  /** The bot's name, for its folder. */
  name?: string
  showSubmitFeedback?: boolean
  /** `row` is a boxed summary that opens to the fields; `fields` shows Computer and Agent side by side. */
  variant?: 'row' | 'fields'
}): React.JSX.Element {
  const t = useTranslate()
  const computerErrorId = useId()
  const agentErrorId = useId()
  const { host, otherAccount } = hostChoice
  const updatable = useServerUpdatable()
  const canUpdate = Boolean(host.environmentId && updatable(host.environmentId))
  const computerError =
    showSubmitFeedback && host.blocked ? computerErrorLabel(host.blocked, canUpdate, t) : null
  const chosen = setup.agent
  const fields = variant === 'fields'
  const computerHint =
    computerError ??
    botCreateHostBlockedHint(host, canUpdate, t) ??
    (otherAccount
      ? t('bots.new.computerAccountHint', 'Where the bot runs, signed in to Orca as {{account}}.', {
          account: otherAccount
        })
      : fields
        ? null
        : t('bots.new.computerHint', 'Where the bot runs.'))
  const noAgents = model.state === 'settled' && choices.length === 0
  const agentInvalid = showSubmitFeedback && !host.blocked && noAgents
  const findingAgents = showSubmitFeedback && !host.blocked && model.state === 'loading'
  const agentLabel = t('bots.new.agent', 'Agent')
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
  const runsOn = (
    <Trans
      i18n={i18n}
      defaults={
        otherAccount
          ? t('bots.new.runsOnAs', 'Runs on <host/>, as <account/>, with <agent/>')
          : t('bots.new.runsOn', 'Runs on <host/> with <agent/>')
      }
      components={{
        host: (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <HostRowIcon hostId={host.hostId} />
            {host.label}
          </span>
        ),
        account: (
          <span className="min-w-0 break-all font-medium text-foreground">{otherAccount}</span>
        ),
        agent: (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            {noAgents ? null : <AgentIcon agent={chosen} size={14} />}
            {noAgents ? agentLabel : botAgentLabel(chosen)}
          </span>
        )
      }}
    />
  )
  const labelVariant = fields ? 'settings' : undefined
  const controls = (
    <>
      <div className="min-w-0 space-y-1">
        <Label variant={labelVariant}>{t('bots.new.computer', 'Computer')}</Label>
        <BotComputerPicker
          hostChoice={hostChoice}
          onAddHost={onAddHost}
          errorId={computerError ? computerErrorId : undefined}
        />
        {computerHint ? (
          <p
            id={computerError ? computerErrorId : undefined}
            role={computerError ? 'alert' : undefined}
            className={cn('text-2xs', computerError ? 'text-destructive' : 'text-muted-foreground')}
          >
            {computerHint}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1">
        <Label variant={labelVariant}>{agentLabel}</Label>
        <div
          role={fields ? 'group' : undefined}
          tabIndex={fields ? -1 : undefined}
          aria-label={fields ? agentLabel : undefined}
          aria-invalid={agentInvalid || undefined}
          aria-describedby={agentInvalid ? agentErrorId : undefined}
          className={
            fields
              ? 'group/agent rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:aria-invalid:ring-destructive/20 dark:focus-visible:aria-invalid:ring-destructive/40'
              : undefined
          }
        >
          {fields && noAgents ? (
            <div
              className={cn(
                COMBOBOX_FIELD_SHELL,
                'text-sm text-muted-foreground group-aria-invalid/agent:border-destructive'
              )}
            >
              {t('bots.new.validation.noAgents', 'No agents')}
            </div>
          ) : noAgents ? (
            <p className="text-2xs text-muted-foreground">
              {t('bots.new.noChatAgents', 'No chat agents available on this computer.')}
            </p>
          ) : (
            <BotAgentLaunchPicker
              key={host.hostId}
              model={model}
              choices={choices.length ? choices : [chosen]}
              value={setup}
              onChange={onSetupChange}
              keptPermission={keptPermission}
              showChatDefaultHint={!fields}
            />
          )}
        </div>
        {agentInvalid ? (
          <p id={agentErrorId} role="alert" className="text-2xs text-destructive">
            {t('bots.new.validation.noAgentsAvailable', 'No agents available')}
          </p>
        ) : null}
        {findingAgents ? (
          <p role="status" className="text-2xs text-muted-foreground">
            {t('bots.new.validation.findingAgents', 'Finding agents…')}
          </p>
        ) : null}
      </div>
      {name !== undefined ? <BotFolderPreview name={name} host={host} /> : null}
    </>
  )
  if (fields) {
    return <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">{controls}</div>
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
