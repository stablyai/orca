import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

type RepoDotLabelProps = {
  name: string
  color: string
  className?: string
  dotClassName?: string
}

function RepoDotLabel({ name, color, className, dotClassName }: RepoDotLabelProps) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span
        className={cn('size-1.5 shrink-0 rounded-full', dotClassName)}
        style={{ backgroundColor: color } as CSSProperties}
      />
      <span className="truncate">{name}</span>
    </span>
  )
}

export default RepoDotLabel
