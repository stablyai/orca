import React, { Suspense, useState } from 'react'
import { ChevronRight, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { translate } from '@/i18n/i18n'
import type { ChecksPanelInnerProps } from './checks-panel-inner-types'

// Why: lazy so the heavy Checks panel (hosted-review + checks + comments) only
// enters the bundle — and only fetches — when a card is first expanded. A
// director may list many workers; eager mounting would trigger N full fetches.
const ChecksPanelInner = lazyWithRetry(
  () => import('./ChecksPanelInner').then((m) => ({ default: m.ChecksPanelInner })),
  { reloadKey: 'mission-control-pr-review-card' }
)

type MissionControlPrReviewCardProps = {
  // Target identity fed straight to ChecksPanelInner. For a live worker this is
  // its own worktree (full merge/CI/comments); for a shipped PR `worktree` is
  // null and the panel resolves by repo + branch + linked-PR.
  target: Omit<ChecksPanelInnerProps, 'isPanelActiveOverride'>
  // The compact collapsed-state content. `headerLeft` sits inside the expand
  // trigger (dot + name); `headerRight` are sibling affordances (state pill +
  // external link) kept out of the trigger button so they aren't nested buttons.
  headerLeft: React.ReactNode
  headerRight?: React.ReactNode
}

export function MissionControlPrReviewCard({
  target,
  headerLeft,
  headerRight
}: MissionControlPrReviewCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
            aria-hidden
          />
          {headerLeft}
        </button>
        {headerRight ? (
          <div className="flex shrink-0 items-center gap-1.5">{headerRight}</div>
        ) : null}
      </div>
      {/* Only mount (and therefore fetch) while expanded — collapsing unmounts the
          inner so its polling stops. */}
      {open ? (
        <div className="border-t border-border">
          <Suspense
            fallback={
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                {translate(
                  'auto.components.right.sidebar.MissionControlPrReviewCard.loading',
                  'Loading review…'
                )}
              </div>
            }
          >
            <ChecksPanelInner {...target} isPanelActiveOverride />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
}
