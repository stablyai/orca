import type { AgentPermissionChoiceRow } from './AgentPermissionChoiceControls'
import { AgentPermissionChoiceItems, AgentPermissionChoiceName } from './AgentPermissionChoiceItems'
import { translate } from '@/i18n/i18n'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '../../ui/dropdown-menu'

export function AgentPermissionMenuOptions({
  agentId,
  permission,
  disabled,
  rawValue,
  showInherited,
  followAll,
  ownLabel
}: {
  agentId: string
  permission: AgentPermissionChoiceRow
  disabled?: boolean
  rawValue?: string
  showInherited: boolean
  followAll: string
  ownLabel: string
}) {
  const guardSkip = permission.guardSkip
  return (
    <>
      <DropdownMenuRadioGroup
        value={
          rawValue ? `raw:${rawValue}` : permission.source === 'all' ? 'default' : permission.choice
        }
      >
        {showInherited ? (
          <>
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
          </>
        ) : null}
        {rawValue ? (
          <DropdownMenuRadioItem value={`raw:${rawValue}`}>
            <AgentPermissionChoiceName choice="own" ownLabel={rawValue} truncate />
          </DropdownMenuRadioItem>
        ) : null}
        <AgentPermissionChoiceItems
          choices={permission.choices}
          agent={agentId}
          ownLabel={ownLabel}
          chatOwnSupported={permission.chatOwnSupported === true}
          disabled={disabled}
          onSelect={permission.onSelect}
        />
      </DropdownMenuRadioGroup>
      {guardSkip ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={guardSkip.enabled}
            disabled={disabled}
            // Keep the menu open: this refines the choice above rather than replacing it.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => guardSkip.onChange(checked === true)}
          >
            <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
              <span>
                {translate(
                  'settings.agents.permissionGuardSkip',
                  'Also skip Claude Code’s built-in refusals'
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {translate(
                  'settings.agents.permissionGuardSkipExplanation',
                  'Claude Code refuses a few commands even with Full access. This removes those refusals too.'
                )}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        </>
      ) : null}
    </>
  )
}
