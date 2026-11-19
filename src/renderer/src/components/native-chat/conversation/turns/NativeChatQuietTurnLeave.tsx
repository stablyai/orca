import type { CSSProperties, ReactNode } from 'react'
import { NATIVE_CHAT_ROW_GAP_PX } from '../../viewport/virtualization/native-chat-row-height-estimate'

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
  const style = (
    gap === 'row'
      ? {
          '--native-chat-quiet-leave-top': `calc(${-NATIVE_CHAT_ROW_GAP_PX}px * var(--chat-estimated-spacing-scale, 1))`
        }
      : {
          [gap === 'above' ? '--native-chat-quiet-leave-top' : '--native-chat-quiet-leave-bottom']:
            '-1.25rem'
        }
  ) as CSSProperties
  return (
    <div className="native-chat-quiet-turn-leave" style={style} aria-hidden>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
