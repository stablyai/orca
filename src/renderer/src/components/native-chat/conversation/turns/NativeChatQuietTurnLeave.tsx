import type { ReactNode } from 'react'

/** A quiet turn's row or bar while the turn settles: it fades, then its space closes with the gap
 *  that goes with it, so nothing below jumps when it goes: the row's own gap above or below (a bar
 *  inside a row), or the transcript's gap before a whole row (`row`). */
export function NativeChatQuietTurnLeave({
  gap,
  children
}: {
  gap: 'above' | 'below' | 'row'
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="native-chat-quiet-turn-leave" data-gap={gap} aria-hidden inert>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
