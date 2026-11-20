import React from 'react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { PROJECT_GROUP_HEADER_INDENT } from './indentation'
import {
  getProjectGroupMoveTargetsForGroup,
  getProjectGroupMoveTargetsForProject
} from './project-group-move-targets'

type ProjectGroupMoveSubmenuProps = {
  /** Every host's groups; the submenu narrows them to the moved item's host. */
  projectGroups: readonly ProjectGroup[]
  disabled?: boolean
  /** Trigger content, so each menu keeps its own icon and label. */
  children: React.ReactNode
} & (
  | { movingGroup: ProjectGroup; onSelect: (parentGroupId: string | null) => void }
  | { movingProject: Repo; onSelect: (groupId: string) => void }
)

// Why: render inside open menu content so the tree is built when a menu opens, not per sidebar row.
export function ProjectGroupMoveSubmenu(
  props: ProjectGroupMoveSubmenuProps
): React.JSX.Element | null {
  const t = useTranslate()
  const destinations =
    'movingGroup' in props
      ? getProjectGroupMoveTargetsForGroup(props.projectGroups, props.movingGroup)
      : getProjectGroupMoveTargetsForProject(props.projectGroups, props.movingProject)
  const topLevel =
    'movingGroup' in props
      ? { disabled: !props.movingGroup.parentGroupId, select: () => props.onSelect(null) }
      : null
  // Why: a group menu drops a submenu with nothing to pick; project menus keep their lone current group.
  const hidden = topLevel
    ? topLevel.disabled && destinations.every((destination) => destination.disabled)
    : destinations.length === 0
  if (hidden) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={props.disabled}>{props.children}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {/* Why: scroll here; the submenu primitive cannot be restyled. */}
        <div className="scrollbar-sleek max-h-80 overflow-y-auto">
          {topLevel ? (
            <>
              <DropdownMenuItem disabled={topLevel.disabled} onSelect={topLevel.select}>
                {t('auto.components.sidebar.ProjectGroupMoveSubmenu.5f1e73c267', 'Top level')}
              </DropdownMenuItem>
              {destinations.length > 0 ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {destinations.map(({ group, depth, disabled }) => (
            <DropdownMenuItem
              key={group.id}
              disabled={disabled}
              data-project-group-move-target={group.id}
              onSelect={() => props.onSelect(group.id)}
            >
              {/* Why: indent inline; computed padding classes on menu primitives are lint-gated. */}
              <span
                className="max-w-48 truncate"
                style={{ paddingLeft: depth * PROJECT_GROUP_HEADER_INDENT }}
              >
                {group.name}
              </span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
