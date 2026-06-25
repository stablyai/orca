import { createContext, useContext, useMemo, type RefObject } from 'react'

type TabDragContextValue = {
  isTabDragActive: boolean
  isTabDragActiveRef: RefObject<boolean>
}

const defaultRef: RefObject<boolean> = { current: false }

const TabDragContext = createContext<TabDragContextValue>({
  isTabDragActive: false,
  isTabDragActiveRef: defaultRef
})

export function TabDragProvider({
  isTabDragActive,
  isTabDragActiveRef,
  children
}: {
  isTabDragActive: boolean
  isTabDragActiveRef: RefObject<boolean>
  children: React.ReactNode
}): React.JSX.Element {
  const value = useMemo(
    () => ({ isTabDragActive, isTabDragActiveRef }),
    [isTabDragActive, isTabDragActiveRef]
  )
  return <TabDragContext.Provider value={value}>{children}</TabDragContext.Provider>
}

export function useTabDragActive(): boolean {
  return useContext(TabDragContext).isTabDragActive
}

export function useTabDragActiveRef(): RefObject<boolean> {
  return useContext(TabDragContext).isTabDragActiveRef
}
