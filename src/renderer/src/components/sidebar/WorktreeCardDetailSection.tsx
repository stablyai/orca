import React from 'react'
import { cn } from '@/lib/utils'

type WorktreeCardDetailSectionProps = React.HTMLAttributes<HTMLElement>
type WorktreeCardDetailSectionContentProps = React.HTMLAttributes<HTMLDivElement>

export function WorktreeCardDetailSection({
  className,
  ...props
}: WorktreeCardDetailSectionProps): React.JSX.Element {
  return <section className={cn('space-y-1.5', className)} {...props} />
}

export function WorktreeCardDetailSectionContent({
  className,
  ...props
}: WorktreeCardDetailSectionContentProps): React.JSX.Element {
  return (
    // Inset section bodies only; titles stay flush with the hovercard hierarchy.
    <div className={cn('border-l border-border/70 pl-3', className)} {...props} />
  )
}
