import { memo, useMemo } from 'react'
import { tabGroupBodyAnchorName } from './tab-group-body-anchor'

type TabGroupBodyOverlaySlotProps = {
  groupId: string | undefined
  isActive: boolean
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  children: React.ReactNode
}

/** A retained live-surface pane anchored over its tab group's body; hidden, not unmounted, when inactive. */
export const TabGroupBodyOverlaySlot = memo(function TabGroupBodyOverlaySlot({
  groupId,
  isActive,
  onFocusOwningGroup,
  children
}: TabGroupBodyOverlaySlotProps): React.JSX.Element {
  const anchorName = groupId !== undefined ? tabGroupBodyAnchorName(groupId) : undefined
  const style: React.CSSProperties = useMemo(
    () =>
      anchorName
        ? {
            position: 'absolute',
            positionAnchor: anchorName,
            top: `anchor(${anchorName} top)`,
            left: `anchor(${anchorName} left)`,
            width: `anchor-size(${anchorName} width)`,
            height: `anchor-size(${anchorName} height)`,
            zIndex: isActive ? 2 : 1,
            visibility: isActive ? 'visible' : 'hidden',
            pointerEvents: isActive ? 'auto' : 'none'
          }
        : { display: 'none' },
    [anchorName, isActive]
  )

  return (
    <div
      style={style}
      className="min-h-0 min-w-0 overflow-hidden"
      onPointerDownCapture={() => {
        if (groupId && onFocusOwningGroup) {
          onFocusOwningGroup(groupId)
        }
      }}
    >
      {children}
    </div>
  )
})
