import React, { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronRight, MessageSquare, Undo2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  canHideWslMovedEntry,
  selectListedWslMovedChatWorkspaces,
  selectWslMovedChatWorkspaces
} from '@/store/repos/wsl-moved-projects'
import { activateWslMovedWorkspace } from '@/lib/workspace/activation/wsl-moved-chat-activation'
import { bringWslMovedProjectBack } from '@/lib/workspace/ownership/wsl-moved-project-use-here'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

function chatLabel(tab: Tab): string {
  return tab.customLabel?.trim() || tab.generatedLabel?.trim() || tab.label
}

function hideMovedProject(project: WslMovedProject, t: ReturnType<typeof useTranslate>): void {
  useAppStore.getState().hideWslMovedProject(project)
  toast.info(
    t('sidebar.wslMoved.hiddenToast', '{{name}} hidden from this list', {
      name: project.displayName
    }),
    {
      description: t(
        'sidebar.wslMoved.hiddenToastDescription',
        '“Use on this computer again” stays in its menu under the {{distro}} host.',
        { distro: project.distro }
      )
    }
  )
}

/**
 * Projects a WSL host now owns, listed read-only with the chats that stay on this computer, if any.
 * Undo brings a project back here as it was before the move; some entries can be hidden, since
 * their host row's menu offers the same undo (`canHideWslMovedEntry`). The rest is the host's.
 */
const WslMovedProjectsSection = React.memo(function WslMovedProjectsSection() {
  const t = useTranslate()
  // Own language subscription: this memo boundary would otherwise keep the boot language.
  useTranslation()
  const confirm = useConfirmationDialog()
  const listId = useId()
  const collapsed = useAppStore((state) => state.wslMovedSectionCollapsed)
  const hiddenKeys = useAppStore((state) => state.hiddenWslMovedProjectKeys)
  const catalog = useAppStore(
    useShallow((state) =>
      // Why: with nothing moved, tab and catalog churn must not re-render this section.
      state.wslMovedProjects.length === 0
        ? null
        : {
            wslMovedProjects: state.wslMovedProjects,
            worktreesByRepo: selectWorktreesByRepo(state),
            folderWorkspaces: selectFolderWorkspaces(state),
            unifiedTabsByWorktree: state.unifiedTabsByWorktree,
            repos: state.repos,
            runtimeEnvironments: state.runtimeEnvironments,
            projectGroups: state.projectGroups
          }
    )
  )
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeTabId = useAppStore((state) => {
    const key = state.activeWorktreeId
    const groupId = key ? state.activeGroupIdByWorktree[key] : undefined
    return key
      ? (state.groupsByWorktree[key]?.find((g) => g.id === groupId)?.activeTabId ?? null)
      : null
  })
  const groups = React.useMemo(
    () =>
      catalog
        ? selectListedWslMovedChatWorkspaces(
            selectWslMovedChatWorkspaces(catalog),
            hiddenKeys,
            catalog
          ).map((entry) => ({ ...entry, canHide: canHideWslMovedEntry(catalog, entry) }))
        : [],
    [catalog, hiddenKeys]
  )
  if (groups.length === 0) {
    return null
  }
  return (
    <section
      data-testid="wsl-moved-projects"
      className="max-h-[40%] shrink-0 overflow-y-auto border-t border-worktree-sidebar-border px-2 py-1 scrollbar-sleek"
    >
      <button
        type="button"
        data-testid="wsl-moved-toggle"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => useAppStore.getState().setWslMovedSectionCollapsed(!collapsed)}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-2xs leading-none text-muted-foreground transition-colors hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-worktree-sidebar-ring"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 transition-transform motion-reduce:transition-none',
            !collapsed && 'rotate-90'
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">
          {t('sidebar.wslMoved.sectionTitle', 'Moved to WSL hosts ({{count}})', {
            count: groups.length
          })}
        </span>
      </button>
      <div id={listId} hidden={collapsed}>
        {groups.map(({ project, workspaces, canHide }) => (
          <div key={`${project.kind}:${project.id}`} data-testid="wsl-moved-project">
            <div className="flex h-7 min-w-0 items-center gap-1 px-1">
              <div className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-none">
                {project.displayName}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-testid="wsl-moved-use-here"
                    aria-label={t('sidebar.wslMoved.useHere', 'Use on this computer again')}
                    onClick={() => void bringWslMovedProjectBack(project, confirm)}
                  >
                    <Undo2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {t('sidebar.wslMoved.useHere', 'Use on this computer again')}
                </TooltipContent>
              </Tooltip>
              {canHide ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      data-testid="wsl-moved-hide"
                      aria-label={t('sidebar.wslMoved.hide', 'Hide from this list')}
                      onClick={() => hideMovedProject(project, t)}
                    >
                      <X />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {t('sidebar.wslMoved.hide', 'Hide from this list')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <div className="truncate px-1 pb-1 text-2xs text-muted-foreground">
              {t('sidebar.wslMoved.movedToHost', 'Moved to {{distro}} host', {
                distro: project.distro
              })}
            </div>
            <ul className="flex flex-col">
              {workspaces.flatMap(({ key, chats }) =>
                chats.map((chat) => (
                  <li key={`${key}\0${chat.id}`}>
                    <button
                      type="button"
                      data-testid="wsl-moved-chat"
                      data-current={activeWorktreeId === key && activeTabId === chat.id}
                      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[13px] hover:bg-worktree-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-worktree-sidebar-ring data-[current=true]:bg-worktree-sidebar-accent"
                      onClick={() => activateWslMovedWorkspace(key, chat.id)}
                    >
                      <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{chatLabel(chat)}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
})

export default WslMovedProjectsSection
