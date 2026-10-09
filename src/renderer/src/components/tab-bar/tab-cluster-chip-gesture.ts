import { useRef } from 'react'
import { useAppStore } from '@/store'
import type { TabCluster } from '../../../../shared/tab-types'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'

export function useTabClusterChipGesture({
  cluster,
  groupId,
  isEditing,
  dragListener
}: {
  cluster: TabCluster
  groupId: string
  isEditing: boolean
  dragListener?: (event: React.PointerEvent<Element>) => void
}) {
  const setCollapsed = useAppStore((state) => state.setTabClusterCollapsed)
  const pointerClickRef = useRef(false)
  const { onPointerDown } = useTabStripPointerActivation({
    // Collapse must not remove the pressed child before Chromium dispatches its click.
    onActivate: () => {
      pointerClickRef.current = true
    },
    disabled: isEditing
  })

  return {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>): void => {
      pointerClickRef.current = false
      onPointerDown(event, dragListener)
    },
    onClick: (event: React.MouseEvent<HTMLDivElement>): void => {
      const pointerWasClick = pointerClickRef.current
      pointerClickRef.current = false
      if (isEditing || (event.detail !== 0 && !pointerWasClick)) {
        return
      }
      setCollapsed(groupId, cluster.id, !cluster.collapsed)
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (isEditing || (event.key !== 'Enter' && event.key !== ' ')) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setCollapsed(groupId, cluster.id, !cluster.collapsed)
    }
  }
}
