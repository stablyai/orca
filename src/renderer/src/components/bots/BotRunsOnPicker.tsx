// Where a new bot runs: Computer and Agent side by side, in New bot and Import from another app.
import React, { useEffect, useId, useRef } from 'react'
import { Label } from '@/components/ui/label'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotAgent } from '../../../../shared/bot-types'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'
import { COMBOBOX_FIELD_SHELL } from '../new-workspace/type-ahead/type-ahead-combobox-styles'
import {
  BotAgentLaunchPicker,
  type BotAgentChatDefault,
  type BotAgentSetup
} from './BotAgentLaunchPicker'
import {
  botCreateHostBlockedHint,
  useServerUpdatable,
  type BotCreateHostBlock,
  type BotCreateHostChoice
} from './bot-create-hosts'
import { BotComputerPicker } from './BotComputerPicker'
import type { BotPermissionIntent } from './use-bot-agent-setup'
import { useWslHostDistro } from '@/components/wsl-host-mark/WslHostMark'
import { BotWslSetupCard } from './BotWslSetupCard'
import { BotWslNoAgentHint } from './BotWslNoAgentHint'

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

export function BotRunsOnPicker({
  hostChoice,
  setup,
  model,
  choices,
  onSetupChange,
  keptPermission,
  onAddHost,
  showSubmitFeedback = false,
  chatDefault
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
  showSubmitFeedback?: boolean
  /** Chat default as the Agent menu's first choice (`useBotAgentSetup`). */
  chatDefault?: BotAgentChatDefault
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
  const computerHint =
    computerError ??
    botCreateHostBlockedHint(host, canUpdate, t) ??
    (otherAccount
      ? t('bots.new.computerAccountHint', 'Where the bot runs, signed in to Orca as {{account}}.', {
          account: otherAccount
        })
      : null)
  const noAgents = model.state === 'settled' && choices.length === 0
  const computerRef = useRef<HTMLDivElement>(null)
  const wslSetup = hostChoice.wslSetup
  const setupState = wslSetup.state
  const settingUp = setupState.phase !== 'idle'
  const wslDistro = useWslHostDistro(host.hostId)
  const addedHostReady =
    setupState.phase === 'finding-agents' &&
    host.environmentId === setupState.environmentId &&
    model.state === 'settled'
  const { finish } = wslSetup
  useEffect(() => {
    if (addedHostReady) {
      finish()
    }
  }, [addedHostReady, finish])
  // A sleeping, waking or unreachable host's agents are unknown, not missing.
  const hostWaking = Boolean(host.sleeping || host.waking)
  const wslNoAgent = noAgents && !settingUp && !hostWaking && !host.blocked && wslDistro !== null
  const agentInvalid = showSubmitFeedback && !host.blocked && noAgents && !settingUp
  const findingAgents = showSubmitFeedback && !host.blocked && model.state === 'loading'
  const agentLabel = t('bots.new.agent', 'Agent')
  const controls = (
    <>
      <div className="min-w-0 space-y-1">
        <Label variant="settings">{t('bots.new.computer', 'Computer')}</Label>
        <div ref={computerRef}>
          <BotComputerPicker
            hostChoice={hostChoice}
            onAddHost={onAddHost}
            errorId={computerError ? computerErrorId : undefined}
          />
        </div>
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
        <Label variant="settings">{agentLabel}</Label>
        <div
          role="group"
          tabIndex={-1}
          aria-label={agentLabel}
          aria-invalid={agentInvalid || undefined}
          aria-describedby={agentInvalid ? agentErrorId : undefined}
          className="group/agent rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:aria-invalid:ring-destructive/20 dark:focus-visible:aria-invalid:ring-destructive/40"
        >
          {settingUp || noAgents || (hostWaking && wslDistro) ? (
            <div
              className={cn(
                COMBOBOX_FIELD_SHELL,
                'text-sm text-muted-foreground group-aria-invalid/agent:border-destructive'
              )}
            >
              <span className="truncate">
                {settingUp
                  ? t('bots.new.wslSetup.waiting', 'Waiting for {{distro}}…', {
                      distro: setupState.distro.name
                    })
                  : hostWaking && wslDistro
                    ? t('bots.new.wslWaking', 'Waking {{distro}}…', { distro: wslDistro })
                    : wslDistro
                      ? t('bots.new.wslNoAgent.field', 'No agent in {{distro}}', {
                          distro: wslDistro
                        })
                      : t('bots.new.validation.noAgents', 'No agents')}
              </span>
            </div>
          ) : (
            <BotAgentLaunchPicker
              key={host.hostId}
              model={model}
              choices={choices.length ? choices : [chosen]}
              value={setup}
              onChange={onSetupChange}
              keptPermission={keptPermission}
              showChatDefaultHint={false}
              chatDefault={chatDefault}
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
    </>
  )
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">{controls}</div>
      <BotWslSetupCard
        state={setupState}
        onCancel={wslSetup.cancel}
        onRetry={wslSetup.retry}
        onChooseAnother={() => {
          wslSetup.cancel()
          // Opens the Computer list, as a click on the field does.
          computerRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.click()
        }}
      />
      {wslNoAgent && wslDistro && host.environmentId ? (
        <BotWslNoAgentHint distro={wslDistro} environmentId={host.environmentId} />
      ) : null}
    </div>
  )
}
