import React, { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { formatPrCommentRelativeTime } from '../../../../shared/pr-comment-time'
import { cn } from '@/lib/utils'
import type { GitStashEntry } from '../../../../shared/git-stash-types'
import {
  describeStashEntry,
  stashPickerCopy,
  type StashPickerMode
} from './source-control-stash-actions'

export function SourceControlStashPicker({
  mode,
  loadEntries,
  onSelect,
  onClose
}: {
  mode: StashPickerMode | null
  loadEntries: () => Promise<GitStashEntry[]>
  onSelect: (entry: GitStashEntry) => void
  onClose: () => void
}): React.JSX.Element {
  const [entries, setEntries] = useState<GitStashEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Why: Radix Dialog scroll-lock cancels wheel events on in-dialog scroll
  // regions, so scroll the list manually (same pattern as BaseRefPicker).
  useEffect(() => {
    const el = listRef.current
    if (!el) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollHeight <= el.clientHeight) {
        return
      }
      event.preventDefault()
      el.scrollTop += event.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // Why: `mode` is a dependency because Radix mounts a fresh DialogContent per
    // open. Keyed on the entry count alone, reopening with the same count would
    // leave the listener bound to the previous, detached node and wheel
    // scrolling would silently stop working.
  }, [entries.length, mode])

  // Why: read the list per open rather than caching it — a stale list would let
  // the user aim a destructive action at the wrong entry.
  useEffect(() => {
    if (!mode) {
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    loadEntries()
      .then((next) => {
        if (!stale) {
          setEntries(next)
        }
      })
      .catch((cause: unknown) => {
        if (!stale) {
          setEntries([])
          setError(
            cause instanceof Error
              ? cause.message
              : translate(
                  'auto.components.right.sidebar.SourceControlStashPicker.loadFailed',
                  'Could not read the stash list.'
                )
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [mode, loadEntries])

  const copy = stashPickerCopy(mode ?? 'stash_pop_pick')
  const destructive = mode === 'stash_drop_pick'
  const nowMs = Date.now()

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div
          ref={listRef}
          className="scrollbar-sleek max-h-72 overflow-y-auto rounded-md border border-border"
          data-testid="source-control-stash-picker-list"
        >
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {translate(
                'auto.components.right.sidebar.SourceControlStashPicker.loading',
                'Reading stashes…'
              )}
            </div>
          ) : error ? (
            <div className="px-3 py-4 text-xs text-destructive">{error}</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.SourceControlStashPicker.empty',
                'No stashes.'
              )}
            </div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.commitOid}
                type="button"
                data-testid={`source-control-stash-entry-${entry.index}`}
                onClick={() => onSelect(entry)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-accent',
                  destructive && 'hover:bg-destructive/10'
                )}
              >
                <span className="w-full truncate text-xs text-foreground">
                  {describeStashEntry(entry)}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {entry.ref}
                  {entry.createdAtSeconds > 0
                    ? ` · ${formatPrCommentRelativeTime(
                        new Date(entry.createdAtSeconds * 1000).toISOString(),
                        nowMs
                      )}`
                    : ''}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
