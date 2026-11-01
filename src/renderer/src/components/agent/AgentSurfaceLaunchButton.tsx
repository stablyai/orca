import React from 'react'
import { MessageSquare, SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/utils'

type AgentSurfaceLaunchButtonProps = Omit<React.ComponentProps<'button'>, 'children' | 'title'> & {
  title: string
  /** The surface this button opens instead of its row's own. */
  surface: 'terminal' | 'chat'
}

/** The trailing control on an agent's row that starts it on the other surface: a chat row's CLI,
 *  or a CLI row's chat. Hidden until its row is highlighted; each list reveals it with its own selector. */
export function AgentSurfaceLaunchButton({
  title,
  surface,
  className,
  ...props
}: AgentSurfaceLaunchButtonProps): React.JSX.Element {
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
      {surface === 'chat' ? <MessageSquare /> : <SquareTerminal />}
    </button>
  )
}
