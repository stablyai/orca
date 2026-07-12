import React from 'react'
import { FolderInput } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getMissionEligibleGroupRepoIds } from './mission-group-selection'

/** Bulk-select convenience for mission member pickers: choosing a project
 *  group adds its subtree's eligible repos to the selection (snapshot). */
export function MissionGroupQuickAdd({
  excludeRepoIds,
  onAdd
}: {
  excludeRepoIds?: ReadonlySet<string>
  onAdd: (repoIds: string[]) => void
}): React.JSX.Element | null {
  const projectGroups = useAppStore((s) => s.projectGroups)
  const repos = useAppStore((s) => s.repos)

  if (projectGroups.length === 0) {
    return null
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
        >
          <FolderInput className="size-3.5" />
          {translate('auto.components.sidebar.MissionGroupQuickAdd.38cb504307', 'Add group')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {projectGroups.map((group) => {
          const groupRepoIds = getMissionEligibleGroupRepoIds(
            projectGroups,
            repos,
            group.id
          ).filter((repoId) => !excludeRepoIds?.has(repoId))
          return (
            <DropdownMenuItem
              key={group.id}
              disabled={groupRepoIds.length === 0}
              onSelect={() => onAdd(groupRepoIds)}
            >
              <span className="max-w-48 truncate">{group.name}</span>
              <span className="ml-auto pl-2 text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.sidebar.MissionGroupQuickAdd.fa306c69f4',
                  '{{value0}} projects',
                  { value0: groupRepoIds.length }
                )}
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
