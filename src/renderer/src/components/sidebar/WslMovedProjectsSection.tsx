import React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Undo2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectWslMovedChatWorkspaces } from '@/store/repos/wsl-moved-projects'
import { activateWslMovedWorkspace } from '@/lib/wsl-moved-chat-activation'
import { bringWslMovedProjectBack } from '@/lib/wsl-moved-project-use-here'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Tab } from '../../../../shared/tab-types'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

function chatLabel(tab: Tab): string {
  return tab.customLabel?.trim() || tab.generatedLabel?.trim() || tab.label
}

/**
 * Projects a WSL host now owns, listed read-only with the chats that stay on this computer, if any.
 * The one action brings a project back here as it was before the move (the move result promises
 * it, so every moved project lists); everything else belongs to the host.
 */
const WslMovedProjectsSection = React.memo(function WslMovedProjectsSection() {
  // Own language subscription: this memo boundary would otherwise keep the boot language.
  useTranslation()
  const confirm = useConfirmationDialog()
  const catalog = useAppStore(
    useShallow((state) =>
      // Why: with nothing moved, tab and catalog churn must not re-render this section.
      state.wslMovedProjects.length === 0
        ? null
        : {
            wslMovedProjects: state.wslMovedProjects,
            worktreesByRepo: selectWorktreesByRepo(state),
            folderWorkspaces: selectFolderWorkspaces(state),
            unifiedTabsByWorktree: state.unifiedTabsByWorktree
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
    () => (catalog ? selectWslMovedChatWorkspaces(catalog) : []),
    [catalog]
  )
  if (groups.length === 0) {
    return null
  }
  return (
    <section
      data-testid="wsl-moved-projects"
      className="max-h-[40%] shrink-0 overflow-y-auto border-t border-worktree-sidebar-border px-2 py-1.5 scrollbar-sleek"
    >
      {groups.map(({ project, workspaces }) => (
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
                  aria-label={translate('sidebar.wslMoved.useHere', 'Use on this computer again')}
                  onClick={() => void bringWslMovedProjectBack(project, confirm)}
                >
                  <Undo2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate('sidebar.wslMoved.useHere', 'Use on this computer again')}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="truncate px-1 pb-1 text-2xs text-muted-foreground">
            {translate('sidebar.wslMoved.movedToHost', 'Moved to {{distro}} host', {
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
    </section>
  )
})

export default WslMovedProjectsSection
