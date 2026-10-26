import { ChevronDown, X } from 'lucide-react'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import type { AgentPermissionChoice } from '../../../../shared/tui-agent-permission-choice'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  nativeChatPermissionModeDescription,
  nativeChatPermissionModeLabel
} from '../native-chat/native-chat-permission-mode-labels'
import { SettingsSegmentedControl } from './SettingsFormControls'

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

// Temporary copy until chats can run an agent's own settings: until then they keep Settings → Chat.
function ownDescription(): string {
  return translate(
    'settings.agents.permissionOwnDescription',
    'Orca adds no permission flag in terminals; chats use Settings → Chat.'
  )
}

export function AllAgentsPermissionSetting({
  choice,
  withoutAutoChoice,
  ownChoiceCount,
  onChange,
  onChangeWithoutAuto
}: {
  choice: AgentPermissionChoice
  /** What the agents without Approve for me share; null when they differ. */
  withoutAutoChoice: AgentPermissionChoice | null
  /** Agents set separately, which choosing a mode here resets. */
  ownChoiceCount: number
  onChange: (choice: AgentPermissionChoice) => void
  onChangeWithoutAuto: (choice: AgentPermissionChoice) => void
}): React.JSX.Element {
  const title = translate(
    'auto.components.settings.AgentsPane.agentPermissions',
    'Agent Permissions'
  )
  return (
    <section className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">
          {choice === 'own'
            ? ownDescription()
            : translate(
                'settings.agents.permissionChoiceDescription',
                'Applies where each agent supports this mode. Change one agent below.'
              )}
        </p>
        {ownChoiceCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.agents.permissionResetsOwnChoices',
              'Choosing a mode here resets the agents marked as set separately.'
            )}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <SettingsSegmentedControl<AgentPermissionChoice>
          value={choice}
          onChange={onChange}
          ariaLabel={title}
          size="sm"
          options={(['own', 'ask', 'auto', 'full-access'] as const).map((value) => ({
            value,
            label:
              value === 'own'
                ? translate('settings.agents.permissionOwnShort', 'Own settings')
                : nativeChatPermissionModeLabel(value)
          }))}
        />
        {choice === 'auto' ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {translate('settings.agents.permissionWithoutAuto', 'Agents without Approve for me')}
            </span>
            <SettingsSegmentedControl<AgentPermissionChoice | 'mixed'>
              value={withoutAutoChoice ?? 'mixed'}
              onChange={(next) => {
                if (next !== 'mixed') {
                  onChangeWithoutAuto(next)
                }
              }}
              ariaLabel={translate(
                'settings.agents.otherAgentsPermissionsLabel',
                'Permissions for other agents'
              )}
              size="sm"
              options={(['own', 'full-access'] as const).map((value) => ({
                value,
                label:
                  value === 'own'
                    ? translate('settings.agents.permissionOwnShort', 'Own settings')
                    : nativeChatPermissionModeLabel(value)
              }))}
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}

export type AgentPermissionChoiceRow = {
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
  permission
}: {
  agentId: string
  label: string
  permission: AgentPermissionChoiceRow
}): React.JSX.Element {
  const followAll = translate('settings.agents.permissionSameAsAll', 'Same as all agents')
  const current = agentPermissionChoiceLabel(permission.choice, label)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-xs font-medium">
        {translate('settings.agents.rowPermissions', 'Permissions')}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={translate('settings.agents.rowPermissionsLabel', '{{agent}} permissions', {
              agent: label
            })}
            className="max-w-full"
          >
            <span className="truncate">
              {permission.source === 'all' ? `${followAll} · ${current}` : current}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" collisionPadding={8} className="w-80">
          <DropdownMenuRadioGroup
            value={permission.source === 'all' ? 'default' : permission.choice}
          >
            <DropdownMenuRadioItem value="default" onSelect={() => permission.onSelect('default')}>
              <span className="truncate">
                {followAll} · {agentPermissionChoiceLabel(permission.defaultChoice, label)}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {permission.choices.map((choice) => (
              <DropdownMenuRadioItem
                key={choice}
                value={choice}
                onSelect={() => permission.onSelect(choice)}
              >
                <div className="min-w-0 py-0.5">
                  <div className={cn(choice === 'full-access' && 'text-status-warning')}>
                    {agentPermissionChoiceLabel(choice, label)}
                  </div>
                  <div className="text-xs font-normal text-muted-foreground">
                    {choice === 'own'
                      ? ownDescription()
                      : nativeChatPermissionModeDescription(choice, agentId)}
                  </div>
                </div>
              </DropdownMenuRadioItem>
            ))}
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

export function AgentPermissionArgsChip({
  label,
  flag,
  onRemove
}: {
  label: string
  flag: string
  onRemove: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex h-5 max-w-[60%] shrink-0 items-center gap-1 rounded bg-muted px-1.5 font-mono text-[11px] text-foreground/80">
          <span className="truncate">{flag}</span>
          <button
            type="button"
            onClick={onRemove}
            aria-label={translate(
              'settings.agents.permissionChipRemove',
              "Remove {{flag}} and use {{agent}}'s own settings",
              { flag, agent: label }
            )}
            className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <X className="size-3" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {translate(
          'settings.agents.permissionChipTooltip',
          'Added by Permissions. Remove it to use {{agent}}’s own settings.',
          { agent: label }
        )}
      </TooltipContent>
    </Tooltip>
  )
}
