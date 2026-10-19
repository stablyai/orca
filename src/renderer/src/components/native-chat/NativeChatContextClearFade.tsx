import type { ReactNode } from 'react'

/** The transcript pane. A live `/clear` fades it out, swaps the transcript while it is unseen
 *  (`NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS`), then fades it back in. */
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
