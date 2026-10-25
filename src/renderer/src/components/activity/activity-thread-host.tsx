import React from 'react'
import { Cloud, Laptop, Server } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import {
  selectExecutionHostDisplayLabel,
  selectNamedExecutionHostLabel
} from '@/lib/execution-host-display-label'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AgentPaneThread } from './activity-thread-types'

type ThreadHostSource = Pick<AgentPaneThread, 'worktree' | 'repo' | 'executionHostId'>

/** The host the session itself names, else the one its workspace row places it on. */
export function getActivityThreadExecutionHostId(thread: ThreadHostSource): ExecutionHostId {
  return (
    thread.executionHostId ?? getWorktreeExecutionHostId(thread.worktree, thread.repo ?? undefined)
  )
}

/** `named` yields null when no recognizable name exists; `display` falls back to the raw id for full details. */
export function useActivityThreadHostLabel(
  thread: ThreadHostSource,
  mode: 'named' | 'display'
): string | null {
  const hostId = getActivityThreadExecutionHostId(thread)
  const worktreeId = thread.worktree.id
  const sessionOwned = thread.executionHostId !== undefined
  return useAppStore((state) => {
    const options = {
      // Why: a session-stamped SSH target is dialed directly; only workspace-derived ones can sit behind a server.
      sshEnvironmentId:
        !sessionOwned && parseExecutionHostId(hostId)?.kind === 'ssh'
          ? runtimeEnvironmentIdUnlessTwin(state, worktreeId)
          : null
    }
    return mode === 'named'
      ? selectNamedExecutionHostLabel(state, hostId, options)
      : selectExecutionHostDisplayLabel(state, hostId, options)
  })
}

export function ExecutionHostGlyph({
  hostId,
  className
}: {
  hostId: ExecutionHostId
  className?: string
}): React.JSX.Element {
  const kind = parseExecutionHostId(hostId)?.kind
  const Icon = kind === 'runtime' ? Cloud : kind === 'ssh' ? Server : Laptop
  return <Icon aria-hidden="true" className={cn('shrink-0', className)} />
}

/** Muted host identity for the row footer; it keeps its width so the workspace label truncates first. */
export function ActivityThreadSessionHost({
  thread
}: {
  thread: ThreadHostSource
}): React.JSX.Element | null {
  const label = useActivityThreadHostLabel(thread, 'named')
  if (!label) {
    return null
  }
  return (
    <span
      className="inline-flex max-w-[55%] shrink-0 items-center gap-0.5 text-muted-foreground"
      title={label}
      data-activity-session-host=""
    >
      <ExecutionHostGlyph hostId={getActivityThreadExecutionHostId(thread)} className="size-2.5" />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}
