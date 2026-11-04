import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Terminal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { revealFloatingWorkspacePanel } from '@/lib/floating-workspace-panel-reveal'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import StatusIndicator from './workspace-card/surface/StatusIndicator'
import { useWorktreeActivityStatus } from './workspace-card/activity/use-worktree-activity-status'
import { useWorktreeAgentRows } from './workspace-card/activity/useWorktreeAgentRows'
import { selectLivePtyIdsForWorktree } from './workspace-card/activity/worktree-card-status-inputs'
import WorktreeCardAgents from './workspace-card/activity/WorktreeCardAgents'

export const FLOATING_SIDEBAR_GROUP_KEY = 'floating'

const FloatingWorkspaceSidebarSection = React.memo(function FloatingWorkspaceSidebarSection() {
  useTranslation()
  const agents = useWorktreeAgentRows(FLOATING_TERMINAL_WORKTREE_ID)
  const livePtyIdsByTabId = useAppStore(
    useShallow((s) => selectLivePtyIdsForWorktree(s, FLOATING_TERMINAL_WORKTREE_ID))
  )
  const liveTerminalCount = useMemo(
    () => Object.values(livePtyIdsByTabId).reduce((sum, ids) => sum + ids.length, 0),
    [livePtyIdsByTabId]
  )
  const isCollapsed = useAppStore((s) => s.collapsedGroups.has(FLOATING_SIDEBAR_GROUP_KEY))
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const isPanelVisible = useAppStore((s) => selectFloatingWorkspacePanelVisible(s))
  const floatingCwd = useAppStore((s) => s.settings?.floatingTerminalCwd?.trim() ?? '')
  const activityStatus = useWorktreeActivityStatus(FLOATING_TERMINAL_WORKTREE_ID)

  if (agents.length === 0 && liveTerminalCount === 0) {
    return null
  }

  const sectionLabel = translate('sidebar.floatingSection.header', 'Floating')
  const cardTitle = translate('sidebar.floatingSection.workspaceTitle', 'Floating workspace')

  return (
    <section
      data-testid="floating-workspace-sidebar-section"
      className="shrink-0 border-t border-worktree-sidebar-border px-2 py-1.5"
    >
      <button
        type="button"
        data-testid="floating-workspace-sidebar-header"
        aria-expanded={!isCollapsed}
        className="group flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:bg-worktree-sidebar-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-worktree-sidebar-ring"
        onClick={() => toggleCollapsedGroup(FLOATING_SIDEBAR_GROUP_KEY)}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <Terminal className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-4">
          {sectionLabel}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">1</span>
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover:text-foreground"
          aria-hidden="true"
        >
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform duration-150',
              isCollapsed && '-rotate-90'
            )}
          />
        </span>
      </button>

      {!isCollapsed ? (
        <div
          role="button"
          tabIndex={0}
          data-testid="floating-workspace-sidebar-card"
          data-worktree-card-active={isPanelVisible ? 'focused' : undefined}
          className={cn(
            'mt-0.5 flex cursor-pointer flex-col rounded-lg border border-transparent px-2 py-1.5 transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-worktree-sidebar-ring',
            isPanelVisible
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'worktree-sidebar-card-hover'
          )}
          onClick={() => revealFloatingWorkspacePanel(useAppStore.getState())}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) {
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              revealFloatingWorkspacePanel(useAppStore.getState())
            }
          }}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <StatusIndicator status={activityStatus} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4">
              {cardTitle}
            </span>
            {liveTerminalCount > 0 ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {liveTerminalCount}
              </span>
            ) : null}
          </div>
          {floatingCwd ? (
            <div className="mt-0.5 truncate pl-[18px] font-mono text-[11px] text-muted-foreground">
              {floatingCwd}
            </div>
          ) : null}
          <WorktreeCardAgents worktreeId={FLOATING_TERMINAL_WORKTREE_ID} agents={agents} />
        </div>
      ) : null}
    </section>
  )
})

export default FloatingWorkspaceSidebarSection
