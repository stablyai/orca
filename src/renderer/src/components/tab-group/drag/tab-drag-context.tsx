import { createContext, useContext, useMemo, type RefObject } from 'react'

type TabDragContextValue = {
  isTabDragActive: boolean
  isTabDragActiveRef: RefObject<boolean>
  /** The dragged tab's visible id; a windowed strip keeps it mounted so the drag survives scrolling. */
  activeDragVisibleTabId: string | null
}

const defaultRef: RefObject<boolean> = { current: false }

const TabDragContext = createContext<TabDragContextValue>({
  isTabDragActive: false,
  isTabDragActiveRef: defaultRef,
  activeDragVisibleTabId: null
})

export function TabDragProvider({
  isTabDragActive,
  isTabDragActiveRef,
  activeDragVisibleTabId,
  children
}: {
  isTabDragActive: boolean
  isTabDragActiveRef: RefObject<boolean>
  activeDragVisibleTabId: string | null
  children: React.ReactNode
}): React.JSX.Element {
  const value = useMemo(
    () => ({ isTabDragActive, isTabDragActiveRef, activeDragVisibleTabId }),
    [isTabDragActive, isTabDragActiveRef, activeDragVisibleTabId]
  )
  return <TabDragContext.Provider value={value}>{children}</TabDragContext.Provider>
}

export function useTabDragActive(): boolean {
  return useContext(TabDragContext).isTabDragActive
}

export function useActiveDragVisibleTabId(): string | null {
  return useContext(TabDragContext).activeDragVisibleTabId
}
