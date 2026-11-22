import type { ReactNode } from 'react'

/** Swap the transcript while hidden during the live /clear fade, then reveal it again. */
export function NativeChatContextClearFade({
  clearing,
  overlay,
  children
}: {
  clearing: boolean
  /** Stays visible and usable over the hidden transcript, e.g. the find bar. */
  overlay?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {overlay}
      <div
        data-clearing={clearing}
        // Hidden for as long as the host takes to stop the agent; nothing invisible takes input.
        inert={clearing}
        className="flex min-h-0 flex-1 flex-col transition-opacity duration-150 ease-out data-[clearing=true]:opacity-0"
      >
        {children}
      </div>
    </div>
  )
}
