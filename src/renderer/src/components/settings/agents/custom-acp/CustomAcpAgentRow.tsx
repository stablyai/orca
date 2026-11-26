// One saved custom ACP agent in Settings: its command, switch, default and actions.

import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { CustomAcpAgent } from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { Button } from '../../../ui/button'
import { Switch } from '../../../ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../../ui/dropdown-menu'
import { SettingsBadge } from '../../form-controls/SettingsFormControls'
import { customAcpAgentCommandLine } from './custom-acp-agent-draft'

export function CustomAcpAgentRow({
  agent,
  disabled,
  isDefault,
  onSetDefault,
  onEdit,
  onSetEnabled,
  onRemove
}: {
  agent: CustomAcpAgent
  disabled: boolean
  isDefault: boolean
  onSetDefault: (isDefault: boolean) => void
  onEdit: () => void
  onSetEnabled: (enabled: boolean) => void
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const editLabel = t('settings.agents.customAcp.edit', 'Edit {{value0}}', { value0: agent.name })
  const removeLabel = t('settings.agents.customAcp.remove', 'Remove {{value0}}', {
    value0: agent.name
  })
  return (
    <div data-settings-row="" className="flex items-center gap-3 py-2.5">
      <div className={cn('min-w-0 flex-1', agent.disabled && 'opacity-40')}>
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">{agent.name}</div>
          {isDefault ? (
            <SettingsBadge className="border-foreground/30 text-foreground">
              {t('auto.components.settings.AgentsPane.24e032fa34', 'Default')}
            </SettingsBadge>
          ) : null}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {customAcpAgentCommandLine(agent)}
        </div>
        {agent.defaultModel ? (
          <div className="truncate text-xs text-muted-foreground">
            {t('settings.agents.customAcp.models.summary', 'Model: {{value0}}', {
              value0: agent.defaultModel
            })}
          </div>
        ) : null}
      </div>
      <Switch
        checked={!agent.disabled}
        disabled={disabled}
        onCheckedChange={onSetEnabled}
        aria-label={t('settings.agents.customAcp.availability', '{{value0}} availability', {
          value0: agent.name
        })}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={editLabel}
        title={editLabel}
        onClick={onEdit}
      >
        <Pencil />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={t('settings.agents.agentActions', '{{agent}} actions', {
              agent: agent.name
            })}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {/* Like a built-in row: an agent that is switched off cannot become the default. */}
          <DropdownMenuItem
            disabled={!isDefault && agent.disabled === true}
            onSelect={() => onSetDefault(!isDefault)}
          >
            {isDefault
              ? t('settings.agents.clearDefault', 'Clear default agent')
              : t('auto.components.settings.AgentsPane.5f986a9b92', 'Set as default')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
