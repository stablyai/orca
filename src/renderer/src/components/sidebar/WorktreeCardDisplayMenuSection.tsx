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
import type { AgentActivityDisplayMode, WorktreeCardProperty } from '../../../../shared/types'
import {
  AGENT_ACTIVITY_DISPLAY_OPTIONS,
  CARD_LAYOUT_OPTIONS,
  getWorktreeCardPropertyOptions
} from './sidebar-workspace-option-items'
import { PROPERTY_OPTIONS } from './worktree-card-display-property-options'
import { translate } from '@/i18n/i18n'

type WorktreeCardDisplayMenuSectionProps = {
  preserveWorkspaceBoardOpen: boolean
}

export function WorktreeCardDisplayMenuSection({
  preserveWorkspaceBoardOpen
}: WorktreeCardDisplayMenuSectionProps): React.JSX.Element {
  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const setWorktreeCardProperties = useAppStore((s) => s.setWorktreeCardProperties)
  const settings = useAppStore((s) => s.settings)
  const setWorktreeCardMode = useAppStore((s) => s.setWorktreeCardMode)
  const agentActivityDisplayMode = useAppStore((s) => s.agentActivityDisplayMode)
  const setAgentActivityDisplayMode = useAppStore((s) => s.setAgentActivityDisplayMode)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const newCardStyle = settings?.experimentalNewWorktreeCardStyle === true
  const cardLayout = settings?.compactWorktreeCards ? 'compact' : 'detailed'
  const cardLayoutLabel =
    CARD_LAYOUT_OPTIONS.find((opt) => opt.id === cardLayout)?.label ?? 'Detailed'
  const visiblePropertyCount = PROPERTY_OPTIONS.filter((opt) =>
    worktreeCardProperties.includes(opt.id)
  ).length
  const hasProjectGroups = projectGroups.length > 0
  const worktreeCardPropertyOptions = useMemo(
    () => getWorktreeCardPropertyOptions({ newCardStyle, hasProjectGroups }),
    [newCardStyle, hasProjectGroups]
  )
  const handleWorktreeCardPropertyChange = useCallback(
    (properties: readonly WorktreeCardProperty[], checked: boolean): void => {
      const next = checked
        ? [...worktreeCardProperties, ...properties]
        : worktreeCardProperties.filter((property) => !properties.includes(property))
      setWorktreeCardProperties(next)
    },
    [setWorktreeCardProperties, worktreeCardProperties]
  )

  if (newCardStyle) {
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
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
        >
          {worktreeCardPropertyOptions.map((opt) => (
            <DropdownMenuCheckboxItem
              key={opt.id}
              checked={opt.properties.every((property) =>
                worktreeCardProperties.includes(property)
              )}
              onCheckedChange={(checked) =>
                handleWorktreeCardPropertyChange(opt.properties, checked === true)
              }
              onSelect={(e) => e.preventDefault()}
            >
              {opt.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  return (
    <>
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
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
        >
          <DropdownMenuRadioGroup
            value={cardLayout}
            onValueChange={(value) => {
              // Why: layout changes are presets, not just density toggles; keep
              // the visible menu path aligned with card property defaults.
              setWorktreeCardMode(value === 'compact' ? 'Compact' : 'Default')
            }}
          >
            {CARD_LAYOUT_OPTIONS.map((opt) => (
              <DropdownMenuRadioItem
                key={opt.id}
                value={opt.id}
                onSelect={(e) => e.preventDefault()}
              >
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="flex flex-1 items-center justify-between">
            <span>
              {translate(
                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.ba87080fb7',
                'Show properties'
              )}
            </span>
            {cardLayout === 'compact' ? (
              <span className="text-[11px] font-medium text-muted-foreground">
                {translate(
                  'auto.components.sidebar.SidebarWorkspaceOptionsMenu.3d4b9c4997',
                  'Hover'
                )}
              </span>
            ) : visiblePropertyCount > 0 ? (
              <span className="text-[11px] font-medium text-muted-foreground">
                {visiblePropertyCount}
              </span>
            ) : null}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className="w-48"
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
        >
          {PROPERTY_OPTIONS.map((opt) => (
            <DropdownMenuCheckboxItem
              key={opt.id}
              checked={worktreeCardProperties.includes(opt.id)}
              onCheckedChange={(checked) =>
                handleWorktreeCardPropertyChange([opt.id], checked === true)
              }
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
            onValueChange={(value) =>
              setAgentActivityDisplayMode(value as AgentActivityDisplayMode)
            }
          >
            {AGENT_ACTIVITY_DISPLAY_OPTIONS.map((opt) => (
              <DropdownMenuRadioItem
                key={opt.id}
                value={opt.id}
                onSelect={(e) => e.preventDefault()}
              >
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  )
}
