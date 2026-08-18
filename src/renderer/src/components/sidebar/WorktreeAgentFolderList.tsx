import { ChevronRight, Folder } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { CompactAgentExpansion } from './worktree-card-compact-agents'
import { buildWorktreeAgentFolderSections } from './worktree-agent-folder-rows'

const EMPTY_FOLDERS: never[] = []
const EMPTY_TABS: never[] = []

type WorktreeAgentFolderListProps = {
  worktreeId: string
  rootAgents: readonly DashboardAgentRow[]
  compact?: boolean
  renderAgent: (agent: DashboardAgentRow) => React.ReactNode
}

export function WorktreeAgentFolderList({
  worktreeId,
  rootAgents,
  compact = false,
  renderAgent
}: WorktreeAgentFolderListProps): React.JSX.Element {
  const folders = useAppStore(
    (state) => state.tabFolderGroupsByWorktree?.[worktreeId] ?? EMPTY_FOLDERS
  )
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree?.[worktreeId] ?? EMPTY_TABS)
  const setCollapsed = useAppStore((state) => state.setTabFolderGroupCollapsed)
  const sections = buildWorktreeAgentFolderSections(rootAgents, folders, tabs)

  return (
    <>
      {sections.map((section) => {
        if (section.type === 'agent') {
          return renderAgent(section.agent)
        }
        const expanded = !section.folder.collapsed
        const header = (
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-xs text-sidebar-foreground hover:bg-sidebar-accent',
              compact && 'h-6'
            )}
            aria-expanded={expanded}
            onClick={() => setCollapsed?.(section.folder.id, expanded)}
          >
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
              aria-hidden
            />
            <Folder className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 truncate">{section.folder.name}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {section.agents.length}
            </span>
          </button>
        )
        const children = section.agents.map((agent) => renderAgent(agent))
        return (
          <div key={section.folder.id} className="flex flex-col">
            {header}
            {compact ? (
              <CompactAgentExpansion expanded={expanded}>
                <div className="flex flex-col gap-0.5 pl-3">{children}</div>
              </CompactAgentExpansion>
            ) : expanded ? (
              <div className="flex flex-col pl-3">{children}</div>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
