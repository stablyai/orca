import type { JSX } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { TAG_ORDER_OPTIONS } from './sidebar-workspace-option-items'

/** Project order, one level down: shown only while the sidebar groups by tag. */
export function TagOrderOptionItem({
  preserveWorkspaceBoardOpen
}: {
  preserveWorkspaceBoardOpen: boolean
}): JSX.Element {
  const tagOrderBy = useAppStore((s) => s.tagOrderBy)
  const setTagOrderBy = useAppStore((s) => s.setTagOrderBy)
  const tagOrderLabel = TAG_ORDER_OPTIONS.find((opt) => opt.id === tagOrderBy)?.label ?? 'Name'
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between">
          <span>
            {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.tagOrder', 'Tag order')}
          </span>
          <span className="text-[11px] font-medium text-muted-foreground">{tagOrderLabel}</span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-44"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <DropdownMenuRadioGroup
          value={tagOrderBy}
          onValueChange={(value) => {
            const next = TAG_ORDER_OPTIONS.find((opt) => opt.id === value)
            if (next) {
              setTagOrderBy(next.id)
            }
          }}
        >
          {TAG_ORDER_OPTIONS.map((opt) => (
            <Tooltip key={opt.id}>
              <TooltipTrigger asChild>
                <DropdownMenuRadioItem
                  value={opt.id}
                  // Keep the menu open so people can compare order modes.
                  onSelect={(e) => e.preventDefault()}
                >
                  {opt.label}
                </DropdownMenuRadioItem>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6}>
                {opt.description}
              </TooltipContent>
            </Tooltip>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
