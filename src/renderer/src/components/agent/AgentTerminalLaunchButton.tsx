import React from 'react'
import { SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/utils'

type AgentTerminalLaunchButtonProps = Omit<React.ComponentProps<'button'>, 'children' | 'title'> & {
  title: string
}

/** The trailing control on an agent's chat row that starts its CLI in a terminal instead.
 *  Hidden until its row is highlighted; each list reveals it with its own selector. */
export function AgentTerminalLaunchButton({
  title,
  className,
  ...props
}: AgentTerminalLaunchButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      title={title}
      aria-label={title}
      className={cn(
        '-my-0.5 grid size-6 shrink-0 place-items-center rounded-md opacity-0 outline-none focus-visible:opacity-100',
        className
      )}
      {...props}
    >
      <SquareTerminal />
    </button>
  )
}
