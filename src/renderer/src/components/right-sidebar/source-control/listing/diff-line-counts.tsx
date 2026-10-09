import React from 'react'
import { cn } from '@/lib/utils'

// Why: use git decoration tokens so counts follow the documented light/dark status palette.
export function DiffLineCounts({
  added,
  removed,
  size = 'xs'
}: {
  added?: number
  removed?: number
  size?: 'xs' | 'sm'
}): React.JSX.Element | null {
  const hasAdded = typeof added === 'number' && added > 0
  const hasRemoved = typeof removed === 'number' && removed > 0
  if (!hasAdded && !hasRemoved) {
    return null
  }
  return (
    <span className={cn('shrink-0 tabular-nums', size === 'sm' ? 'text-xs' : 'text-[10px]')}>
      {hasAdded && <span style={{ color: 'var(--git-decoration-added)' }}>+{added}</span>}
      {hasAdded && hasRemoved && <span> </span>}
      {hasRemoved && <span style={{ color: 'var(--git-decoration-deleted)' }}>-{removed}</span>}
    </span>
  )
}
