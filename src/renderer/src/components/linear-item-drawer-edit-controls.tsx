import React from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'

export const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

export const LINEAR_EDIT_CHIP_CLASS =
  'inline-flex h-6 min-w-0 max-w-[14rem] cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 text-[11px] font-medium leading-none text-muted-foreground shadow-xs transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent hover:text-accent-foreground hover:[--linear-state-pill-current-background:var(--linear-state-pill-hover-background)] hover:[--linear-state-pill-current-border:var(--linear-state-pill-hover-border)] hover:[--linear-state-pill-current-foreground:var(--linear-state-pill-hover-foreground)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-80'

export const LINEAR_EDIT_MENU_ITEM_CLASS =
  'flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent'

export const LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent'

export const LINEAR_ESTIMATE_PRESETS = [1, 2, 3, 5, 8] as const

export function formatLinearEstimateLabel(estimate: number | null | undefined): string {
  return estimate === null || estimate === undefined ? 'Set estimate' : `Estimate ${estimate}`
}

export function formatLinearEstimateInput(estimate: number | null | undefined): string {
  return estimate === null || estimate === undefined ? '' : String(estimate)
}

export function LinearEditChipAdornment({
  loading,
  pending
}: {
  loading?: boolean
  pending?: boolean
}): React.JSX.Element {
  if (loading || pending) {
    return <LoaderCircle className="size-3 shrink-0 animate-spin opacity-70" />
  }

  return <ChevronDown className="size-3 shrink-0 opacity-55" />
}
