import type { AgentPermissionChoiceRow } from './AgentPermissionChoiceControls'
import { AgentPermissionChoiceItems, AgentPermissionChoiceName } from './AgentPermissionChoiceItems'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '../ui/dropdown-menu'

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
  return (
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
  )
}
