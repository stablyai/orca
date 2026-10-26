import type { ReactNode } from 'react'

/** Swap the transcript while hidden during the live /clear fade, then reveal it again. */
export function NativeChatContextClearFade({
  clearing,
  children
}: {
  clearing: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      data-clearing={clearing}
      className="relative flex min-h-0 flex-1 flex-col transition-opacity duration-150 ease-out data-[clearing=true]:opacity-0"
    >
      {children}
    </div>
  )
}
