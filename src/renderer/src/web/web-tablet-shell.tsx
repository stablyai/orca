import { useEffect, useRef } from 'react'
import { useWebTabletLayout } from './web-tablet-layout'

// Why module-level: React Compiler cannot lower Import expressions inside a
// component, so the lazy store load (avoids a module cycle) lives here.
async function collapseRightSidebarOnTabletEntry(): Promise<void> {
  const module = await import('../store')
  module.useAppStore.getState().setRightSidebarOpen(false)
}

// Why: the shell owns the html-level tablet class, so every web surface — pairing
// included, which is all a fresh iPad profile can reach — gets the touch layout.
export function WebTabletShell({ children }: React.PropsWithChildren): React.JSX.Element {
  const isTablet = useWebTabletLayout()
  // Why once: freeing canvas on entry helps, but later toggles are the user's choice.
  const collapsedRightSidebar = useRef(false)
  useEffect(() => {
    document.documentElement.classList.toggle('web-tablet', isTablet)
    return () => document.documentElement.classList.remove('web-tablet')
  }, [isTablet])
  useEffect(() => {
    if (isTablet && !collapsedRightSidebar.current) {
      collapsedRightSidebar.current = true
      void collapseRightSidebarOnTabletEntry()
    }
  }, [isTablet])
  return <>{children}</>
}
