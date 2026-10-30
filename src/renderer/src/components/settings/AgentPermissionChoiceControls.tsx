import { ChevronDown, X } from 'lucide-react'
import type { Ref } from 'react'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import type { AgentPermissionChoice } from '../../../../shared/tui-agent-permission-choice'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { nativeChatPermissionModeLabel } from '../native-chat/native-chat-permission-mode-labels'
import { AgentPermissionChoiceItems, AgentPermissionChoiceName } from './AgentPermissionChoiceItems'

/** Use chat-mode wording; own names the agent when available. */
export function agentPermissionChoiceLabel(
  choice: AgentPermissionChoice,
  agentLabel: string | null
): string {
  if (choice !== 'own') {
    return nativeChatPermissionModeLabel(choice)
  }
  return agentLabel
    ? translate('settings.agents.permissionOwnAgent', "Use {{agent}}'s own settings", {
        agent: agentLabel
      })
    : translate('settings.agents.permissionOwnAll', "Agents' own settings")
}

export function AllAgentsPermissionSetting({
  chatOwnSupported = false,
  choice,
  withoutAutoChoice,
  onChange,
  onChangeWithoutAuto
}: {
  chatOwnSupported?: boolean
  choice: AgentPermissionChoice | null
  /** What the agents without Approve for me share; null when they differ. */
  withoutAutoChoice: AgentPermissionChoice | null
  onChange: (choice: AgentPermissionChoice) => void
  onChangeWithoutAuto: (choice: AgentPermissionChoice) => void
}): React.JSX.Element {
  const title = translate('settings.agents.permissionsTitle', 'Permissions')
  const ownLabel = translate('settings.agents.permissionEachOwn', "Each agent's own settings")
  const withoutAutoTitle = translate(
    'settings.agents.otherAgentsPermissionsLabel',
    'Permissions for other agents'
  )
  return (
    <section className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={choice === null}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label={title}
              className="w-48 max-w-full justify-between"
            >
              {choice === null ? (
                <span className="h-4" />
              ) : (
                <AgentPermissionChoiceName choice={choice} ownLabel={ownLabel} truncate />
              )}
              <ChevronDown className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" collisionPadding={8} className="w-72">
            <DropdownMenuRadioGroup aria-label={title} value={choice ?? ''}>
              <AgentPermissionChoiceItems
                choices={['ask', 'auto', 'full-access', 'own']}
                ownLabel={ownLabel}
                chatOwnSupported={chatOwnSupported}
                onSelect={onChange}
              />
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'settings.agents.permissionsChoiceExplanation',
          'What every agent may do without asking. You can set one agent differently below.'
        )}
      </p>
      <div className="min-h-6">
        {choice === 'auto' ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {translate('settings.agents.permissionWithoutAuto', 'Agents without Approve for me')}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  aria-label={withoutAutoTitle}
                  className="min-w-0 max-w-full"
                >
                  {withoutAutoChoice === null ? (
                    <span className="truncate">
                      {translate('settings.agents.permissionMixed', 'Mixed')}
                    </span>
                  ) : (
                    <AgentPermissionChoiceName
                      choice={withoutAutoChoice}
                      ownLabel={ownLabel}
                      truncate
                    />
                  )}
                  <ChevronDown className="size-3 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" collisionPadding={8} className="w-72">
                <DropdownMenuRadioGroup
                  aria-label={withoutAutoTitle}
                  value={withoutAutoChoice ?? ''}
                >
                  <AgentPermissionChoiceItems
                    choices={['full-access', 'own']}
                    ownLabel={ownLabel}
                    chatOwnSupported={chatOwnSupported}
                    onSelect={onChangeWithoutAuto}
                  />
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export type AgentPermissionChoiceRow = {
  chatOwnSupported?: boolean
  choices: readonly AgentPermissionChoice[]
  choice: AgentPermissionChoice
  source: 'agent' | 'all'
  terminalChoice?: AgentPermissionChoice
  chatChoice?: AgentChatPermissionMode | null
  /** What this agent gets from the all-agents choice. */
  defaultChoice: AgentPermissionChoice
  onSelect: (choice: AgentPermissionChoice | 'default') => void
  /** The flag terminals add, shown as a chip in Arguments; empty when none. */
  flag: string
  /** The agent's own Arguments set permissions, so terminals use those instead. */
  argsSetPermission: boolean
}

export function AgentPermissionMenu({
  agentId,
  label,
  permission,
  inheritLabel,
  disabled,
  size = 'xs',
  layout = 'inline'
}: {
  agentId: string
  label: string
  permission: AgentPermissionChoiceRow
  inheritLabel?: string
  disabled?: boolean
  size?: 'xs' | 'sm'
  layout?: 'inline' | 'stacked'
}): React.JSX.Element {
  const followAll =
    inheritLabel ?? translate('settings.agents.permissionSameAsAll', 'Same as all agents')
  const ownLabel = agentPermissionChoiceLabel('own', label)
  return (
    <div
      className={cn(
        'flex min-w-0',
        layout === 'stacked'
          ? 'flex-col items-stretch gap-2'
          : 'flex-wrap items-center gap-x-3 gap-y-1'
      )}
    >
      {layout === 'stacked' ? (
        <Label variant="settings">
          {translate('settings.agents.rowPermissions', 'Permissions')}
        </Label>
      ) : (
        <span className="text-xs font-medium">
          {translate('settings.agents.rowPermissions', 'Permissions')}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size={size}
            aria-label={translate('settings.agents.rowPermissionsLabel', '{{agent}} permissions', {
              agent: label
            })}
            className={cn('min-w-0 max-w-full', layout === 'stacked' && 'w-full justify-between')}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              {permission.source === 'all' ? <span className="shrink-0">{followAll} ·</span> : null}
              <AgentPermissionChoiceName choice={permission.choice} ownLabel={ownLabel} truncate />
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" collisionPadding={8} className="w-72">
          <DropdownMenuRadioGroup
            value={permission.source === 'all' ? 'default' : permission.choice}
          >
            <DropdownMenuRadioItem
              value="default"
              disabled={disabled}
              onSelect={() => permission.onSelect('default')}
            >
              <span className="flex min-w-0 items-center gap-1.5 py-0.5">
                <span className="shrink-0">{followAll} ·</span>
                <AgentPermissionChoiceName
                  choice={permission.defaultChoice}
                  ownLabel={ownLabel}
                  truncate
                />
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            <AgentPermissionChoiceItems
              choices={permission.choices}
              agent={agentId}
              ownLabel={ownLabel}
              chatOwnSupported={permission.chatOwnSupported === true}
              disabled={disabled}
              onSelect={permission.onSelect}
            />
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {permission.terminalChoice === 'own' && permission.chatChoice ? (
        <span className="text-xs text-muted-foreground">
          {translate(
            'settings.agents.permissionSurfaceDifference',
            'Terminals use the agent’s own settings; new chats use {{mode}}.',
            { mode: nativeChatPermissionModeLabel(permission.chatChoice) }
          )}
        </span>
      ) : null}
    </div>
  )
}

function AgentArgsChoiceChip({
  label,
  flag,
  onRemove,
  disabled,
  chipRef,
  buttonRef,
  choiceKey
}: {
  label: string
  flag: string
  onRemove: () => void
  disabled?: boolean
  chipRef?: Ref<HTMLSpanElement>
  buttonRef?: Ref<HTMLButtonElement>
  choiceKey: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          ref={chipRef}
          className="flex h-5 min-w-0 max-w-full items-center gap-1 rounded bg-muted px-1.5 font-mono text-xs leading-5 text-foreground/80 focus-within:ring-2 focus-within:ring-ring"
        >
          <span className="truncate">{flag}</span>
          <button
            ref={buttonRef}
            type="button"
            disabled={disabled}
            onClick={onRemove}
            onKeyDown={(event) => {
              if (event.key === 'Backspace') {
                event.preventDefault()
                if (
                  !disabled &&
                  !event.repeat &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                ) {
                  onRemove()
                }
              }
            }}
            aria-label={
              choiceKey !== 'permissionMode'
                ? translate('settings.agents.choiceChipRemove', 'Remove {{flag}}', { flag })
                : translate(
                    'settings.agents.permissionChipRemove',
                    "Remove {{flag}} and use {{agent}}'s own settings",
                    { flag, agent: label }
                  )
            }
            className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-3" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {choiceKey !== 'permissionMode'
          ? translate(
              'settings.agents.choiceChipTooltip',
              'Added by {{choice}}. Remove it to use the default.',
              {
                choice:
                  choiceKey === 'model'
                    ? translate('settings.sourceControl.actionModel.model', 'Model')
                    : translate('settings.sourceControl.actionModel.effort', 'Effort')
              }
            )
          : translate(
              'settings.agents.permissionChipTooltip',
              'Added by Permissions. Remove it to use {{agent}}’s own settings.',
              { agent: label }
            )}
      </TooltipContent>
    </Tooltip>
  )
}

export type AgentArgsChoice = {
  key: string
  label: string
  flag: string
  onRemove: (text: string) => string
}

export function AgentArgsChoiceChips({
  chips,
  disabled,
  chipRef,
  buttonRef,
  onRemove
}: {
  chips: readonly AgentArgsChoice[]
  disabled?: boolean
  chipRef?: Ref<HTMLSpanElement>
  buttonRef?: Ref<HTMLButtonElement>
  onRemove: (chip: AgentArgsChoice) => void
}): React.JSX.Element {
  return (
    <span
      ref={chipRef}
      className="relative z-10 -mb-5 flex h-5 w-fit max-w-full items-center gap-1"
    >
      {chips.map((chip, index) => (
        <AgentArgsChoiceChip
          key={chip.key}
          choiceKey={chip.key}
          label={chip.label}
          flag={chip.flag}
          disabled={disabled}
          buttonRef={index === chips.length - 1 ? buttonRef : undefined}
          onRemove={() => onRemove(chip)}
        />
      ))}
    </span>
  )
}
