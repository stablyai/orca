import React, { useCallback, useEffect, useState } from 'react'
import { ChevronDown, GitBranch, GitPullRequest } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { GitHubWorkItem } from '../../../../shared/types'
import StartFromPicker, { type StartFromSelection } from './StartFromPicker'

type StartFromFieldProps = {
  repoId: string
  repoPath: string | null
  isRemoteRepo: boolean
  baseBranch: string | undefined
  baseBranchLinkedPrNumber: number | null
  onBaseBranchChange: (next: string | undefined) => void
  onBaseBranchPrSelect: (baseBranch: string, item: GitHubWorkItem) => void
  /** Transient inline hint, e.g. "was PR #8778" after a repo switch reset. */
  resetHint?: string | null
}

export default function StartFromField({
  repoId,
  repoPath,
  isRemoteRepo,
  baseBranch,
  baseBranchLinkedPrNumber,
  onBaseBranchChange,
  onBaseBranchPrSelect,
  resetHint
}: StartFromFieldProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hintVisible, setHintVisible] = useState(Boolean(resetHint))
  const [defaultBaseRef, setDefaultBaseRef] = useState<string | null>(null)

  useEffect(() => {
    setHintVisible(Boolean(resetHint))
  }, [resetHint])

  // Resolve the actual default ref (e.g. "origin/main") so the trigger can
  // show a concrete branch name instead of the vague phrase "Default branch".
  useEffect(() => {
    let stale = false
    setDefaultBaseRef(null)
    void window.api.repos
      .getBaseRefDefault({ repoId })
      .then((ref) => {
        if (!stale) {
          setDefaultBaseRef(ref)
        }
      })
      .catch(() => {
        if (!stale) {
          setDefaultBaseRef(null)
        }
      })
    return () => {
      stale = true
    }
  }, [repoId])

  const handleSelect = useCallback(
    (selection: StartFromSelection): void => {
      setHintVisible(false)
      if (selection.kind === 'default') {
        onBaseBranchChange(undefined)
        return
      }
      if (selection.kind === 'branch') {
        onBaseBranchChange(selection.baseBranch)
        return
      }
      onBaseBranchPrSelect(selection.baseBranch, selection.item)
    },
    [onBaseBranchChange, onBaseBranchPrSelect]
  )

  const labelPrimary =
    baseBranchLinkedPrNumber !== null
      ? `PR #${baseBranchLinkedPrNumber}`
      : baseBranch
        ? baseBranch
        : (defaultBaseRef ?? 'Default branch')
  const isDefault = baseBranchLinkedPrNumber === null && !baseBranch
  const Icon = baseBranchLinkedPrNumber !== null ? GitPullRequest : GitBranch

  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">Start from</label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-xs shadow-xs transition-[color,box-shadow] outline-none hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{labelPrimary}</span>
              {isDefault && defaultBaseRef ? (
                <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                  (default)
                </span>
              ) : null}
              {hintVisible && resetHint ? (
                <span className="truncate text-[10px] font-normal text-muted-foreground">
                  — {resetHint}
                </span>
              ) : null}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="p-0" sideOffset={4}>
          <StartFromPicker
            repoId={repoId}
            repoPath={repoPath}
            isRemoteRepo={isRemoteRepo}
            currentBaseBranch={baseBranch}
            onSelect={handleSelect}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
