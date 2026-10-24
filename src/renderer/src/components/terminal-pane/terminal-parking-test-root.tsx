import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  disposeTerminalViewParkingOwner,
  flushTerminalViewParking,
  getTerminalParkingRevision,
  startTerminalViewParkingOwner,
  subscribeTerminalParkingFlush
} from './terminal-view-parking-owner'
export function TerminalParkingTestRoot({ children }: { children: ReactNode }): React.JSX.Element {
  const revision = useSyncExternalStore(
    subscribeTerminalParkingFlush,
    getTerminalParkingRevision,
    getTerminalParkingRevision
  )
  useEffect(() => startTerminalViewParkingOwner(), [])
  useEffect(() => {
    flushTerminalViewParking()
  }, [revision])
  return <>{children}</>
}
export function createTerminalParkingTestRoot(container: Element): Root {
  const root = createRoot(container)
  return {
    ...root,
    render: (children) =>
      root.render(<TerminalParkingTestRoot>{children}</TerminalParkingTestRoot>),
    unmount: () => {
      root.unmount()
      disposeTerminalViewParkingOwner()
    }
  }
}
