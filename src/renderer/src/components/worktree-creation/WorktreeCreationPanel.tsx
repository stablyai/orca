import React from 'react'
import { AlertTriangle, Check, GitBranchPlus, Loader2, RotateCcw, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { retryBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import type { WorktreeCreationPhase } from '@/lib/pending-worktree-creation'

const STEPS: { key: WorktreeCreationPhase; label: string }[] = [
  { key: 'fetching', label: 'Fetching base branch' },
  { key: 'creating', label: 'Creating worktree' }
]

function phaseIndex(phase: WorktreeCreationPhase): number {
  // Why: derive the active step from STEPS order so adding a phase can't silently
  // desync the index from the rendered list.
  return STEPS.findIndex((step) => step.key === phase)
}

function StepRow({
  label,
  state
}: {
  label: string
  state: 'done' | 'active' | 'pending'
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {state === 'done' ? (
          <Check className="size-4 text-muted-foreground" />
        ) : state === 'active' ? (
          <Loader2 className="size-4 animate-spin text-foreground" />
        ) : (
          <span className="size-2 rounded-full bg-muted-foreground/30" />
        )}
      </span>
      <span
        className={cn(
          'text-sm',
          state === 'pending' ? 'text-muted-foreground/60' : 'text-foreground'
        )}
      >
        {label}
      </span>
    </div>
  )
}

export default function WorktreeCreationPanel({
  creationId
}: {
  creationId: string
}): React.JSX.Element | null {
  const entry = useAppStore((s) => s.pendingWorktreeCreations[creationId])
  if (!entry) {
    return null
  }

  const name = entry.request.displayName || entry.request.name
  const isError = entry.status === 'error'

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-6">
        <div className="flex flex-col items-center gap-5 py-8">
          <div
            className={cn(
              'flex size-16 items-center justify-center rounded-2xl border',
              isError ? 'border-destructive/40 bg-destructive/5' : 'border-border/80 bg-card'
            )}
          >
            {isError ? (
              <AlertTriangle className="size-7 text-destructive" />
            ) : (
              <GitBranchPlus className="size-7 text-muted-foreground" />
            )}
          </div>

          <div className="flex flex-col items-center gap-1 text-center">
            <h2 className="text-lg font-semibold text-foreground">
              {isError ? "Couldn't create worktree" : 'Creating worktree'}
            </h2>
            <p className="max-w-sm truncate text-sm text-muted-foreground">{name}</p>
          </div>

          {isError ? (
            <>
              <p className="max-w-sm text-center text-sm text-muted-foreground">
                {entry.error ?? 'Something went wrong while creating the worktree.'}
              </p>
              <div className="flex items-center gap-2">
                <Button onClick={() => retryBackgroundWorktreeCreation(creationId)}>
                  <RotateCcw className="size-4" />
                  Retry
                </Button>
                <Button
                  variant="outline"
                  onClick={() => useAppStore.getState().removePendingWorktreeCreation(creationId)}
                >
                  <X className="size-4" />
                  Dismiss
                </Button>
              </div>
            </>
          ) : (
            <>
              {entry.indeterminate ? (
                <div className="flex items-center gap-2.5">
                  <Loader2 className="size-4 animate-spin text-foreground" />
                  <span className="text-sm text-foreground">Setting up your worktree…</span>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {STEPS.map((step, index) => {
                    const current = phaseIndex(entry.phase)
                    const state =
                      index < current ? 'done' : index === current ? 'active' : 'pending'
                    return <StepRow key={step.key} label={step.label} state={state} />
                  })}
                </div>
              )}
              <p className="max-w-sm text-center text-xs text-muted-foreground/70">
                Setup runs in its own terminal tab once the worktree is ready. You can keep working
                elsewhere meanwhile.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => useAppStore.getState().removePendingWorktreeCreation(creationId)}
              >
                <X className="size-4" />
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
