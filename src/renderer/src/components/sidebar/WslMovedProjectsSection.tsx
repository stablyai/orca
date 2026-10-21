import React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectWslMovedChatWorkspaces } from '@/store/repos/wsl-moved-projects'
import { activateWslMovedWorkspace } from '@/lib/wsl-moved-chat-activation'
import type { Tab } from '../../../../shared/tab-types'

function chatLabel(tab: Tab): string {
  return tab.customLabel?.trim() || tab.generatedLabel?.trim() || tab.label
}

/**
 * Projects a WSL host now owns, listed read-only for the chats that stay on this computer. No
 * actions: new chats, terminals and edits belong to the host, which lists the project itself.
 */
const WslMovedProjectsSection = React.memo(function WslMovedProjectsSection() {
  // Own language subscription: this memo boundary would otherwise keep the boot language.
  useTranslation()
  const catalog = useAppStore(
    useShallow((state) =>
      // Why: with nothing moved, tab and catalog churn must not re-render this section.
      state.wslMovedProjects.length === 0
        ? null
        : {
            wslMovedProjects: state.wslMovedProjects,
            worktreesByRepo: state.worktreesByRepo,
            folderWorkspaces: state.folderWorkspaces,
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
          <div className="flex h-7 min-w-0 items-center px-1">
            <div className="min-w-0 truncate text-[13px] font-semibold leading-none">
              {project.displayName}
            </div>
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
