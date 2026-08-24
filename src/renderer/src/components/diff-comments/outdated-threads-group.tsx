import React, { useState } from 'react'
import { ChevronDown, ChevronRight, History } from 'lucide-react'
import { ReviewThreadCard } from './ReviewThreadCard'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import { outdatedThreadsCountLabel } from './review-thread-copy'

// Why: GitHub can no longer anchor these threads to the current diff. They render
// grouped above the file — "outdated over misplaced" — instead of on a wrong line.

const noopResize = (): void => {}

export function OutdatedThreadsGroup({
  threads
}: {
  threads: DecoratedDiffComment[]
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (threads.length === 0) {
    return null
  }
  return (
    <div className="border-b border-border bg-muted/20">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <History className="size-3" />
        {outdatedThreadsCountLabel(threads.length)}
      </button>
      {expanded ? (
        <div className="flex flex-col gap-1 px-3 pb-2">
          {threads.map((thread) => (
            <ReviewThreadCard key={thread.id} comment={thread} onContentResize={noopResize} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
