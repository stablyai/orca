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

export function SidebarClientScopeSwitcher(): React.JSX.Element {
  const projectGroups = useAppStore((s) => s.projectGroups ?? EMPTY_PROJECT_GROUPS)
  const focusedProjectGroupId = useAppStore((s) => s.focusedProjectGroupId)
  const setFocusedProjectGroupId = useAppStore((s) => s.setFocusedProjectGroupId)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const [createOpen, setCreateOpen] = useState(false)

  const rootClients = useMemo(
    () =>
      projectGroups
        .filter((group) => group.parentGroupId == null)
        .slice()
        .sort(
          (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
        ),
    [projectGroups]
  )
  const resolvedFocusId = resolveFocusedProjectGroupId(projectGroups, focusedProjectGroupId)
  const focusedGroup = projectGroups.find((group) => group.id === resolvedFocusId)
  const focusLabel = focusedGroup
    ? focusedGroup.name
    : translate('auto.components.sidebar.SidebarClientScopeSwitcher.allClients', 'All clients')

  // Why: deleting a focused client must not leave a sticky empty sidebar after catalog refresh.
  React.useEffect(() => {
    if (focusedProjectGroupId && !resolvedFocusId) {
      setFocusedProjectGroupId(null)
    }
  }, [focusedProjectGroupId, resolvedFocusId, setFocusedProjectGroupId])

  const handleCreateClient = useCallback(
    async (name: string) => {
      const group = await createProjectGroup(name)
      if (group) {
        setFocusedProjectGroupId(group.id)
      }
    },
    [createProjectGroup, setFocusedProjectGroupId]
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
                  'auto.components.sidebar.SidebarClientScopeSwitcher.aria',
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
              'auto.components.sidebar.SidebarClientScopeSwitcher.tooltip',
              'Clients · {{value0}}',
              { value0: focusLabel }
            )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="bottom" align="start" sideOffset={6} className="w-56">
          <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
            {translate('auto.components.sidebar.SidebarClientScopeSwitcher.label', 'Focus client')}
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
                  'auto.components.sidebar.SidebarClientScopeSwitcher.allClients',
                  'All clients'
                )}
              </span>
            </span>
          </DropdownMenuItem>
          {rootClients.map((group) => (
            <DropdownMenuItem key={group.id} onSelect={() => setFocusedProjectGroupId(group.id)}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {resolvedFocusId === group.id ? (
                  <Check className="size-3.5 shrink-0" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{group.name}</span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <Plus className="size-3.5" strokeWidth={2.25} />
            {translate(
              'auto.components.sidebar.SidebarClientScopeSwitcher.newClient',
              'New client…'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectGroupNameDialog
        open={createOpen}
        title={translate(
          'auto.components.sidebar.SidebarClientScopeSwitcher.createTitle',
          'New client'
        )}
        description={translate(
          'auto.components.sidebar.SidebarClientScopeSwitcher.createDescription',
          'Create a client folder, then move projects into it from each project menu.'
        )}
        initialName=""
        confirmLabel={translate(
          'auto.components.sidebar.SidebarClientScopeSwitcher.createConfirm',
          'Create'
        )}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreateClient}
      />
    </>
  )
}
