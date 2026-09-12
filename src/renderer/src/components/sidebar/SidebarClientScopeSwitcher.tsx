import React, { useCallback, useMemo, useState } from 'react'
import { Building2, Check, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { resolveFocusedProjectGroupId } from '../../../../shared/project-group-focus'
import { EMPTY_PROJECT_GROUPS } from './worktree-list/viewport/viewport-props'
import {
  flattenProjectGroupsForMenu,
  formatProjectGroupMenuLabel
} from './project-group-menu-labels'

export function SidebarClientScopeSwitcher(): React.JSX.Element {
  const projectGroups = useAppStore((s) => s.projectGroups ?? EMPTY_PROJECT_GROUPS)
  const focusedProjectGroupId = useAppStore((s) => s.focusedProjectGroupId)
  const setFocusedProjectGroupId = useAppStore((s) => s.setFocusedProjectGroupId)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const [createOpen, setCreateOpen] = useState(false)

  const menuClients = useMemo(() => flattenProjectGroupsForMenu(projectGroups), [projectGroups])
  const groupsById = useMemo(
    () => new Map(projectGroups.map((group) => [group.id, group])),
    [projectGroups]
  )
  const resolvedFocusId = resolveFocusedProjectGroupId(projectGroups, focusedProjectGroupId)
  const focusedGroup = projectGroups.find((group) => group.id === resolvedFocusId)
  const focusLabel = focusedGroup
    ? formatProjectGroupMenuLabel(focusedGroup, groupsById).trim()
    : translate('auto.components.sidebar.SidebarClientScopeSwitcher.bf84d099da', 'All clients')

  // Why: deleting a focused client must not leave a sticky empty sidebar after catalog refresh.
  React.useEffect(() => {
    if (focusedProjectGroupId && !resolvedFocusId) {
      setFocusedProjectGroupId(null)
    }
  }, [focusedProjectGroupId, resolvedFocusId, setFocusedProjectGroupId])

  const handleCreateClient = useCallback(
    async (name: string) => {
      const group = await createProjectGroup(
        name,
        resolvedFocusId ? { parentGroupId: resolvedFocusId } : undefined
      )
      if (group) {
        // Why: keep focus on the outer client so the new nested folder appears in-scope.
        if (!resolvedFocusId) {
          setFocusedProjectGroupId(group.id)
        }
      }
    },
    [createProjectGroup, resolvedFocusId, setFocusedProjectGroupId]
  )

  return (
    <>
      <DropdownMenu modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={translate(
                  'auto.components.sidebar.SidebarClientScopeSwitcher.159d02ed2f',
                  'Switch client: {{value0}}',
                  { value0: focusLabel }
                )}
                data-sidebar-client-scope=""
              >
                <Building2 className="size-3.5" strokeWidth={2.25} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.sidebar.SidebarClientScopeSwitcher.1fc28be149',
              'Clients · {{value0}}',
              { value0: focusLabel }
            )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="bottom" align="start" sideOffset={6} className="w-56">
          <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
            {translate(
              'auto.components.sidebar.SidebarClientScopeSwitcher.5f9196f74c',
              'Focus client'
            )}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setFocusedProjectGroupId(null)}>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {resolvedFocusId == null ? (
                <Check className="size-3.5 shrink-0" />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <span className="truncate">
                {translate(
                  'auto.components.sidebar.SidebarClientScopeSwitcher.bf84d099da',
                  'All clients'
                )}
              </span>
            </span>
          </DropdownMenuItem>
          {menuClients.map((group) => (
            <DropdownMenuItem key={group.id} onSelect={() => setFocusedProjectGroupId(group.id)}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {resolvedFocusId === group.id ? (
                  <Check className="size-3.5 shrink-0" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{formatProjectGroupMenuLabel(group, groupsById)}</span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <Plus className="size-3.5" strokeWidth={2.25} />
            {resolvedFocusId
              ? translate(
                  'auto.components.sidebar.SidebarClientScopeSwitcher.068ae2c11d',
                  'New client inside…'
                )
              : translate(
                  'auto.components.sidebar.SidebarClientScopeSwitcher.95d7cdc817',
                  'New client…'
                )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectGroupNameDialog
        open={createOpen}
        title={
          focusedGroup
            ? translate(
                'auto.components.sidebar.SidebarClientScopeSwitcher.c4ff9de729',
                'New client inside {{value0}}',
                { value0: focusedGroup.name }
              )
            : translate(
                'auto.components.sidebar.SidebarClientScopeSwitcher.deeb49e60c',
                'New client'
              )
        }
        description={
          focusedGroup
            ? translate(
                'auto.components.sidebar.SidebarClientScopeSwitcher.086b546962',
                'Create a client nested under {{value0}}, then use + on it to add projects.',
                { value0: focusedGroup.name }
              )
            : translate(
                'auto.components.sidebar.SidebarClientScopeSwitcher.be14f13df1',
                'Create a client folder, then use + on the client to add projects into it.'
              )
        }
        initialName=""
        confirmLabel={translate(
          'auto.components.sidebar.SidebarClientScopeSwitcher.dca8fcfb2d',
          'Create'
        )}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreateClient}
      />
    </>
  )
}
