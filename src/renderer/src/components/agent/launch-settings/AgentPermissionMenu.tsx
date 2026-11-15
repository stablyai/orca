import { useTranslate } from '../../../i18n/use-translate'
import { cn } from '../../../lib/class-names'
import { ChevronDown } from 'lucide-react'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../ui/dropdown-menu'
import { nativeChatPermissionModeLabel } from '../../native-chat/session/options/controls/native-chat-permission-mode-labels'
import { AgentPermissionChoiceName } from './AgentPermissionChoiceItems'
import { AgentPermissionMenuOptions } from './AgentPermissionMenuOptions'
import type { AgentPermissionChoiceRow } from './agent-permission-choice-row'
import { agentPermissionChoiceLabel } from './agent-permission-choice-label'

export function AgentPermissionMenu({
  agentId,
  label,
  permission,
  inheritLabel,
  onOpenChange,
  disabled,
  size = 'xs',
  layout = 'inline',
  showInherited = true,
  rawValue
}: {
  agentId: string
  label: string
  permission: AgentPermissionChoiceRow
  inheritLabel?: string
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  size?: 'xs' | 'sm'
  /** Row: muted label left and the menu right, like the chat composer's option rows. */
  layout?: 'inline' | 'stacked' | 'row'
  showInherited?: boolean
  rawValue?: string
}): React.JSX.Element {
  const t = useTranslate()
  const followAll = inheritLabel ?? t('settings.agents.permissionSameAsAll', 'Same as all agents')
  const ownLabel = agentPermissionChoiceLabel('own', label, t)
  return (
    <div
      className={cn(
        'flex min-w-0',
        layout === 'stacked'
          ? 'flex-col items-stretch gap-2'
          : layout === 'row'
            ? 'min-h-7 items-center justify-between gap-3'
            : 'flex-wrap items-center gap-x-3 gap-y-1'
      )}
    >
      {layout === 'row' ? (
        <span className="text-xs text-muted-foreground">
          {t('settings.agents.rowPermissions', 'Permissions')}
        </span>
      ) : layout === 'stacked' ? (
        <Label variant="settings">{t('settings.agents.rowPermissions', 'Permissions')}</Label>
      ) : (
        <span className="text-xs font-medium">
          {t('settings.agents.rowPermissions', 'Permissions')}
        </span>
      )}
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size={size}
            aria-label={t('settings.agents.rowPermissionsLabel', '{{agent}} permissions', {
              agent: label
            })}
            className={cn('min-w-0 max-w-full', layout === 'stacked' && 'w-full justify-between')}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              {permission.source === 'all' ? <span className="shrink-0">{followAll} ·</span> : null}
              <AgentPermissionChoiceName
                choice={rawValue ? 'own' : permission.choice}
                ownLabel={rawValue ?? ownLabel}
                truncate
              />
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" collisionPadding={8} className="w-80">
          <AgentPermissionMenuOptions
            agentId={agentId}
            permission={permission}
            disabled={disabled}
            rawValue={rawValue}
            showInherited={showInherited}
            followAll={followAll}
            ownLabel={ownLabel}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {permission.terminalChoice === 'own' && permission.chatChoice ? (
        <span className="text-xs text-muted-foreground">
          {t(
            'settings.agents.permissionSurfaceDifference',
            'Terminals use the agent’s own settings; new chats use {{mode}}.',
            { mode: nativeChatPermissionModeLabel(permission.chatChoice, t) }
          )}
        </span>
      ) : null}
    </div>
  )
}
