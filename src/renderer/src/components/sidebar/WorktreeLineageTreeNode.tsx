import React from 'react'
import {
  FolderGit2,
  GitBranch,
  GitFork,
  Layers,
  Sparkles,
  ExternalLink,
  Unlink
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorktreeLineageTreeNode as TreeNodeType } from './worktree-lineage-tree-model'

export type WorktreeLineageTreeNodeProps = {
  node: TreeNodeType
  activeWorktreeId: string | null
  onSelectWorktree: (worktreeId: string) => void
  onUnlinkWorktree: (worktreeId: string) => void
  isLast?: boolean
}

export const WorktreeLineageTreeNode = React.memo(function WorktreeLineageTreeNode({
  node,
  activeWorktreeId,
  onSelectWorktree,
  onUnlinkWorktree
}: WorktreeLineageTreeNodeProps): React.JSX.Element {
  const isActive = node.worktree.id === activeWorktreeId

  return (
    <div className="relative flex flex-col">
      <div
        className={cn(
          'relative rounded-lg border p-3 transition-colors',
          node.isNewlyLinked
            ? 'border-emerald-500/50 bg-emerald-500/5 ring-1 ring-emerald-500/30'
            : node.isTarget
              ? 'border-primary/40 bg-primary/5'
              : 'border-border bg-card/60 hover:bg-card/90'
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {node.isRoot ? (
              <Badge variant="secondary" className="gap-1 text-[11px]">
                <Layers className="size-3 text-muted-foreground" />
                {translate('auto.components.sidebar.lineageTree.rootBadge', 'Root / Parent')}
              </Badge>
            ) : node.isNewlyLinked ? (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[11px] font-semibold text-emerald-500"
              >
                <Sparkles className="size-3 text-emerald-500" />
                {translate('auto.components.sidebar.lineageTree.linkedBadge', 'Newly Linked')}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground">
                <GitFork className="size-3" />
                {translate('auto.components.sidebar.lineageTree.childBadge', 'Child')}
              </Badge>
            )}

            {isActive ? (
              <Badge variant="dot" className="text-[11px] text-primary">
                {translate('auto.components.sidebar.lineageTree.activeBadge', 'Active')}
              </Badge>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            {!isActive ? (
              <Button
                variant="ghost"
                size="xs"
                className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onSelectWorktree(node.worktree.id)}
              >
                <ExternalLink className="size-3" />
                {translate('auto.components.sidebar.lineageTree.openAction', 'Open')}
              </Button>
            ) : null}

            {!node.isRoot ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 px-1.5 text-muted-foreground hover:text-destructive"
                    onClick={() => onUnlinkWorktree(node.worktree.id)}
                  >
                    <Unlink className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {translate(
                    'auto.components.sidebar.lineageTree.unlinkAction',
                    'Unlink from parent'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <FolderGit2 className="size-4 shrink-0 text-primary" />
          <span className="font-semibold text-sm text-foreground">
            {node.repo?.displayName ?? node.worktree.repoId}
          </span>
          <span className="text-muted-foreground">/</span>
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs text-foreground/90 font-medium">
            {node.worktree.displayName}
          </span>
        </div>

        <div className="mt-1.5 text-[11px] font-mono text-muted-foreground truncate">
          {node.worktree.path}
        </div>
      </div>

      {node.children.length > 0 ? (
        <div className="relative ml-4 mt-2 border-l-2 border-border/60 pl-4 space-y-2">
          {node.children.map((child, index) => (
            <div key={child.worktree.id} className="relative">
              {/* horizontal connector line from parent vertical line */}
              <div className="absolute -left-4 top-5 w-4 border-t-2 border-border/60" />
              <WorktreeLineageTreeNode
                node={child}
                activeWorktreeId={activeWorktreeId}
                onSelectWorktree={onSelectWorktree}
                onUnlinkWorktree={onUnlinkWorktree}
                isLast={index === node.children.length - 1}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})
