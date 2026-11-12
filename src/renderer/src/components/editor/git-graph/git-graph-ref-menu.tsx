import { useStore } from 'zustand'
import type { GitGraphCommitActionsController } from './git-graph-commit-actions-controller'
import type { useGitCommitActionsSupport } from '@/runtime/source-control/git/git-commit-actions-capability'
import { useMemo, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { gitGraphScope } from '@/lib/source-control/graph/git-graph-tab'
import { gitGraphWorkspaceCatalog } from './git-graph-workspace-navigation'
import { GitGraphRefWorkspaceAgents } from './git-graph-ref-workspace-agents'
import { useTranslate } from '@/i18n/use-translate'
import type { GitHistoryItemRef } from '../../../../../shared/git/history/git-history-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { cn } from '@/lib/class-names'

export function useGitGraphWorkspaces(
  scope: ReturnType<typeof gitGraphScope>,
  // Agent sessions also run in the workspace showing the graph, which is not a switch target.
  withCurrent = false
) {
  const worktrees = useAppStore(selectWorktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  return useMemo(
    () =>
      new Map(
        [
          ...gitGraphWorkspaceCatalog(scope, { repos, worktreesByRepo: worktrees }),
          ...(withCurrent && scope ? [scope.worktree] : [])
        ].map((row) => [
          row.branch.startsWith('refs/heads/') ? row.branch : `refs/heads/${row.branch}`,
          row
        ])
      ),
    [scope, worktrees, repos, withCurrent]
  )
}

export function GitGraphRefs({
  references,
  currentRefId,
  workspaces,
  agentWorkspaces,
  onSwitch,
  onCheckout,
  controller,
  support
}: {
  references: GitHistoryItemRef[]
  currentRefId?: string
  workspaces: Map<string, Worktree>
  agentWorkspaces: Map<string, Worktree>
  onSwitch: (refId: string) => Promise<void>
  onCheckout: (ref: GitHistoryItemRef) => void
  controller: GitGraphCommitActionsController
  support: ReturnType<typeof useGitCommitActionsSupport>
}) {
  const t = useTranslate()
  const running = useStore(controller.view, (state) => state.running)
  const [open, setOpen] = useState(false)
  const [menuRef, setMenuRef] = useState<GitHistoryItemRef>()
  const current = references.find((ref) => ref.id === currentRefId)
  const inline = current ? [current] : []
  for (const ref of references) {
    if (inline.length === 2) {
      break
    }
    if (workspaces.has(ref.id) && ref !== current) {
      inline.push(ref)
    }
  }
  for (const ref of references) {
    if (inline.length === 2) {
      break
    }
    if (!inline.includes(ref)) {
      inline.push(ref)
    }
  }
  const badge = (ref: GitHistoryItemRef) => {
    const workspace = workspaces.get(ref.id)
    const agentWorkspace = agentWorkspaces.get(ref.id)
    return (
      <ContextMenuTrigger asChild key={ref.id}>
        <span
          onContextMenu={(event) => {
            event.stopPropagation()
            setMenuRef(ref)
          }}
          className={cn(
            'inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-full border px-1.5 text-2xs text-muted-foreground',
            ref.id === currentRefId && 'bg-accent font-medium text-foreground'
          )}
        >
          <span className="min-w-0 truncate" title={ref.name}>
            {ref.name}
          </span>
          {agentWorkspace && <GitGraphRefWorkspaceAgents worktree={agentWorkspace} />}
          {workspace && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="shrink-0"
                  aria-label={t('gitGraph.switchWorkspace', 'Switch to workspace')}
                  onClick={(event) => {
                    event.stopPropagation()
                    void onSwitch(ref.id)
                  }}
                >
                  <ArrowUpRight className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {t('gitGraph.switchWorkspace', 'Switch to workspace')}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      </ContextMenuTrigger>
    )
  }
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) {
          setMenuRef(undefined)
        }
      }}
    >
      <div className="flex w-full min-w-0 gap-1">
        {inline.map(badge)}
        {references.length > inline.length && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                className="shrink-0 text-2xs text-muted-foreground"
                onClick={(event) => event.stopPropagation()}
              >
                +{references.length - inline.length}
              </button>
            </PopoverTrigger>
            {open && (
              <PopoverContent onClick={(event) => event.stopPropagation()}>
                <div className="max-h-72 space-y-1 overflow-auto scrollbar-sleek">
                  {references.filter((ref) => !inline.includes(ref)).map(badge)}
                </div>
              </PopoverContent>
            )}
          </Popover>
        )}
      </div>
      {menuRef && (
        <ContextMenuContent onClick={(event) => event.stopPropagation()}>
          <ContextMenuItem onSelect={() => void window.api.ui.writeClipboardText(menuRef.name)}>
            {t('gitGraph.copyBranch', 'Copy branch name')}
          </ContextMenuItem>
          {menuRef.id !== currentRefId &&
            !workspaces.has(menuRef.id) &&
            (menuRef.id.startsWith('refs/heads/') || menuRef.id.startsWith('refs/remotes/')) && (
              <>
                <ContextMenuItem
                  disabled={running || !support.supported}
                  onSelect={() => onCheckout(menuRef)}
                >
                  {t('gitGraph.checkoutBranch', 'Check out branch')}
                </ContextMenuItem>
                {support.reason && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{support.reason}</p>
                )}
              </>
            )}
          {workspaces.has(menuRef.id) && (
            <ContextMenuItem onSelect={() => void onSwitch(menuRef.id)}>
              {t('gitGraph.switchWorkspace', 'Switch to workspace')}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}
