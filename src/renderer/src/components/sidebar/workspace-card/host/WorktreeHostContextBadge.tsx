import React from 'react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Can name local and remote machines; callers decide visibility, unlike badges that hide local hosts. */
export function WorktreeHostContextBadge({
  label,
  className,
  title
}: {
  label: string
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <Badge variant="hostContext" className={cn('max-w-[7rem]', className)} title={title}>
      <span className="truncate">{label}</span>
    </Badge>
  )
}
