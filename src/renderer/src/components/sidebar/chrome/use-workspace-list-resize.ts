import { useCallback } from 'react'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { scaledSidebarWidthCss } from './sidebar-drawer-left-edge'
import { setSidebarLiveWidth } from './sidebar-live-width'

export function useWorkspaceListResize(
  isOpen: boolean,
  width: number,
  setWidth: (width: number) => void
) {
  const applyRenderedSize = useCallback(
    (element: HTMLDivElement, size: number) => {
      element.style.width = isOpen
        ? `calc(${scaledSidebarWidthCss(`${size}px`)} / var(--sidebar-zoom-ratio, 1))`
        : '0px'
    },
    [isOpen]
  )
  return useSidebarResize<HTMLDivElement>({
    isOpen,
    width,
    setWidth,
    minWidth: 220,
    maxWidth: 500,
    deltaSign: 1,
    applyRenderedSize,
    onDraftWidthChange: setSidebarLiveWidth
  })
}
