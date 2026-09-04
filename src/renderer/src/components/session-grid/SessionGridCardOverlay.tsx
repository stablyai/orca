import React from 'react'
import { GitBranch, GripVertical } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import type { SessionGridItem } from '../../../../shared/session-grid-types'
import { SessionGridCardIdentityIcon, useSessionGridCardAgent } from './session-grid-card-agent'
import { sessionGridBranchMeta } from './session-grid-worktree-catalog'

type SessionGridCardOverlayProps = {
  item: SessionGridItem
}

export function SessionGridCardOverlay({ item }: SessionGridCardOverlayProps): React.JSX.Element {
  const agent = useSessionGridCardAgent(item)
  const branchMeta = sessionGridBranchMeta(item)
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-primary/60 bg-card/90 shadow-floating ring-2 ring-primary/40 backdrop-blur-md cursor-grabbing select-none">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/80 bg-muted/70 px-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <GripVertical className="size-3.5 shrink-0 text-primary/80" />
          <span className="truncate max-w-[220px]">
            {item.worktreeName !== item.repoName ? (
              <span className="text-muted-foreground">{item.repoName} / </span>
            ) : null}
            <span className="font-medium text-foreground">{item.worktreeName}</span>
          </span>
          {branchMeta && (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <GitBranch className="size-2.5 shrink-0" />
              <span className="truncate">{branchMeta}</span>
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
            <SessionGridCardIdentityIcon agent={agent} shell={item.shellOverride} />
            <span className="truncate max-w-[180px]">{item.title}</span>
          </span>
          <div className="shrink-0">
            <AgentStateDot state={item.dotState} size="sm" />
          </div>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center bg-background/80 p-4 text-xs text-muted-foreground/60">
        <span className="font-mono text-[11px]">{item.title}</span>
      </div>
    </div>
  )
}
