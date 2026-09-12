import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type TerminalQuickCommandCollapsibleRowProps = {
  open: boolean
  className?: string
  children: ReactNode
}

/** Why: switching action adds/removes fields; animating the rows keeps the
 *  dialog from snapping between content heights. */
export function TerminalQuickCommandCollapsibleRow({
  open,
  className,
  children
}: TerminalQuickCommandCollapsibleRowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
      aria-hidden={!open}
    >
      <div className="min-h-0">
        <div
          className={cn(
            'transition-[opacity,transform] duration-150 ease-out',
            open ? 'translate-y-0 opacity-100 delay-200' : '-translate-y-1 opacity-0 delay-0',
            className
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
