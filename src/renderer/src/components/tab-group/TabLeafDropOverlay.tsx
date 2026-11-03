import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { translate } from '@/i18n/i18n'
import { describeTerminalTabIntoPaneRefusal } from '../terminal-pane/terminal-tab-into-pane-reasons'
import TabGroupDropOverlay from './TabGroupDropOverlay'
import type { TabDragLeafTarget } from './tab-drag-leaf-target'

/** The half of the pane on the side a joined tab would land on. */
function getHalfBounds({
  leafRect: rect,
  zone
}: TabDragLeafTarget): Pick<CSSProperties, 'top' | 'left' | 'width' | 'height'> {
  switch (zone) {
    case 'up':
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height / 2 }
    case 'down':
      return {
        top: rect.top + rect.height / 2,
        left: rect.left,
        width: rect.width,
        height: rect.height / 2
      }
    case 'left':
      return { top: rect.top, left: rect.left, width: rect.width / 2, height: rect.height }
    case 'right':
      return {
        top: rect.top,
        left: rect.left + rect.width / 2,
        width: rect.width / 2,
        height: rect.height
      }
  }
}

/** "Join tab" on the pane edge a dragged terminal would join, or the reason it cannot. */
export default function TabLeafDropOverlay({
  target
}: {
  target: TabDragLeafTarget
}): React.JSX.Element {
  return createPortal(
    <div
      aria-hidden="true"
      data-leaf-drop-overlay=""
      data-disabled={target.refusal ? '' : undefined}
      className="pointer-events-none fixed z-[10001]"
      style={getHalfBounds(target)}
    >
      <TabGroupDropOverlay
        zone={target.zone}
        fillContainer
        disabled={target.refusal !== null}
        label={
          target.refusal
            ? describeTerminalTabIntoPaneRefusal(target.refusal)
            : translate('auto.components.tab.group.TabLeafDropOverlay.joinLabel', 'Join tab')
        }
      />
    </div>,
    document.body
  )
}
