import { ChevronDown } from 'lucide-react'
import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { AgentPermissionChoiceItems, AgentPermissionChoiceName } from './AgentPermissionChoiceItems'
import { agentPermissionModeChoice } from './agent-permission-mode-label'

/** Legacy hosts keep their launch modes; only the menu uses the shared choice vocabulary. */
export function AgentPermissionModeMenu({
  mode,
  label,
  autoAvailable,
  autoDisabled,
  onChange
}: {
  mode: AgentPermissionMode
  label: string
  autoAvailable: boolean
  autoDisabled?: boolean
  onChange: (mode: Exclude<AgentPermissionMode, 'mixed'>) => void
}): React.JSX.Element {
  const ownLabel = translate('settings.agents.permissionEachOwn', "Each agent's own settings")
  const choice = mode === 'mixed' ? '' : agentPermissionModeChoice(mode)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={label}
          className="min-w-0 max-w-full"
        >
          {choice === '' ? (
            <span className="truncate">
              {translate('settings.agents.permissionMixed', 'Mixed')}
            </span>
          ) : (
            <AgentPermissionChoiceName choice={choice} ownLabel={ownLabel} truncate />
          )}
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} className="w-72">
        <DropdownMenuRadioGroup aria-label={label} value={choice}>
          {autoAvailable ? (
            <AgentPermissionChoiceItems
              choices={['auto']}
              ownLabel={ownLabel}
              chatOwnSupported={false}
              disabled={autoDisabled}
              onSelect={() => onChange('auto')}
            />
          ) : null}
          <AgentPermissionChoiceItems
            choices={['full-access', 'own']}
            ownLabel={ownLabel}
            chatOwnSupported={false}
            onSelect={(next) => onChange(next === 'own' ? 'manual' : 'yolo')}
          />
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
