import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import { getWorkspaceCardPropertiesValue } from '../../../../shared/workspace-view/workspace-view-options'
import {
  AGENT_ACTIVITY_DISPLAY_OPTIONS,
  CARD_LAYOUT_OPTIONS,
  PROPERTY_OPTIONS,
  getWorktreeCardDisplayOptions
} from './sidebar-workspace-option-items'
import { translate } from '@/i18n/i18n'

type CardMenuItemProps = {
  preserveWorkspaceBoardOpen: boolean
}

function boardAttr(preserveWorkspaceBoardOpen: boolean): '' | undefined {
  return preserveWorkspaceBoardOpen ? '' : undefined
}

function useToggleCardProperty(): (property: WorktreeCardProperty, checked: boolean) => void {
  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const setWorktreeCardProperties = useAppStore((s) => s.setWorktreeCardProperties)
  return useCallback(
    (property, checked) => {
      const next = checked
        ? [...worktreeCardProperties, property]
        : worktreeCardProperties.filter((candidate) => candidate !== property)
      setWorktreeCardProperties(next)
    },
    [setWorktreeCardProperties, worktreeCardProperties]
  )
}

/** "Card display": the experimental card style's property rows. */
export function WorktreeCardDisplayMenuItem({
  preserveWorkspaceBoardOpen
}: CardMenuItemProps): React.JSX.Element {
  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const hasProjectGroups = useAppStore((s) => s.projectGroups.length > 0)
  const toggleProperty = useToggleCardProperty()
  const options = useMemo(() => getWorktreeCardDisplayOptions(hasProjectGroups), [hasProjectGroups])
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          {translate(
            'auto.components.sidebar.SidebarWorkspaceOptionsMenu.newCardDisplay.title',
            'Card display'
          )}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-56"
        data-workspace-board-preserve-open={boardAttr(preserveWorkspaceBoardOpen)}
      >
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.id}
            checked={worktreeCardProperties.includes(opt.id)}
            onCheckedChange={(checked) => toggleProperty(opt.id, checked === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function WorktreeCardLayoutMenuItem({
  preserveWorkspaceBoardOpen
}: CardMenuItemProps): React.JSX.Element {
  const compact = useAppStore((s) => s.settings?.compactWorktreeCards === true)
  const setWorktreeCardMode = useAppStore((s) => s.setWorktreeCardMode)
  const cardLayout = compact ? 'compact' : 'detailed'
  const cardLayoutLabel =
    CARD_LAYOUT_OPTIONS.find((opt) => opt.id === cardLayout)?.label ?? 'Detailed'
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between">
          <span>
            {translate(
              'auto.components.sidebar.SidebarWorkspaceOptionsMenu.320b675c9a',
              'Card layout'
            )}
          </span>
          <span className="text-[11px] font-medium text-muted-foreground">{cardLayoutLabel}</span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-44"
        data-workspace-board-preserve-open={boardAttr(preserveWorkspaceBoardOpen)}
      >
        <DropdownMenuRadioGroup
          value={cardLayout}
          onValueChange={(value) => {
            // Apply layout presets so menu selection stays aligned with card-property defaults.
            setWorktreeCardMode(value === 'compact' ? 'Compact' : 'Default')
          }}
        >
          {CARD_LAYOUT_OPTIONS.map((opt) => (
            <DropdownMenuRadioItem key={opt.id} value={opt.id} onSelect={(e) => e.preventDefault()}>
              {opt.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** "Show properties", with the agent activity layout below the property rows. */
export function WorktreeCardPropertiesMenuItem({
  preserveWorkspaceBoardOpen
}: CardMenuItemProps): React.JSX.Element {
  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const compact = useAppStore((s) => s.settings?.compactWorktreeCards === true)
  const agentActivityDisplayMode = useAppStore((s) => s.agentActivityDisplayMode)
  const setAgentActivityDisplayMode = useAppStore((s) => s.setAgentActivityDisplayMode)
  const toggleProperty = useToggleCardProperty()
  const value = getWorkspaceCardPropertiesValue(worktreeCardProperties, compact)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between">
          <span>
            {translate(
              'auto.components.sidebar.SidebarWorkspaceOptionsMenu.ba87080fb7',
              'Show properties'
            )}
          </span>
          {value === null ? null : (
            <span className="text-[11px] font-medium text-muted-foreground">
              {value === 'hover'
                ? translate(
                    'auto.components.sidebar.SidebarWorkspaceOptionsMenu.3d4b9c4997',
                    'Hover'
                  )
                : value}
            </span>
          )}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-48"
        data-workspace-board-preserve-open={boardAttr(preserveWorkspaceBoardOpen)}
      >
        {PROPERTY_OPTIONS.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.id}
            checked={worktreeCardProperties.includes(opt.id)}
            onCheckedChange={(checked) => toggleProperty(opt.id, checked === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {translate(
            'auto.components.sidebar.SidebarWorkspaceOptionsMenu.95c9754653',
            'Agent activity layout'
          )}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={agentActivityDisplayMode}
          onValueChange={(value) => {
            const next = AGENT_ACTIVITY_DISPLAY_OPTIONS.find((opt) => opt.id === value)
            if (next) {
              setAgentActivityDisplayMode(next.id)
            }
          }}
        >
          {AGENT_ACTIVITY_DISPLAY_OPTIONS.map((opt) => (
            <DropdownMenuRadioItem key={opt.id} value={opt.id} onSelect={(e) => e.preventDefault()}>
              {opt.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
