import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

type RepoBadgeMarkProps = {
  color: string | null | undefined
  className?: string
}

export function RepoBadgeMark({ color, className }: RepoBadgeMarkProps) {
  const style: CSSProperties | undefined = color ? { backgroundColor: color } : undefined

  return (
    <span aria-hidden="true" className={cn('block size-1.5 shrink-0', className)} style={style} />
  )
}

type RepoBadgeLabelProps = {
  name: string
  color: string
  className?: string
  badgeClassName?: string
}

function RepoBadgeLabel({ name, color, className, badgeClassName }: RepoBadgeLabelProps) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <RepoBadgeMark color={color} className={badgeClassName} />
      <span className="truncate">{name}</span>
    </span>
  )
}

export default RepoBadgeLabel
