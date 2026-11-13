import { cn } from '@/lib/class-names'

/** The user-picked tab color, shared by the tab strip and every row that stands for that tab. */
export function TabColorDot({
  color,
  className
}: {
  color: string | null | undefined
  className?: string
}): React.JSX.Element | null {
  if (!color) {
    return null
  }
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
    />
  )
}
