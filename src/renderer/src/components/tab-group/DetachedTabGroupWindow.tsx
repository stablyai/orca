import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { openAuxPaneWindow, type AuxPaneWindow } from '@/lib/aux-pane-window'
import {
  registerAuxPaneContainer,
  unregisterAuxPaneContainer
} from '@/lib/aux-pane-window-registry'
import { useAppStore } from '../../store'
import { AuxWindowContainerProvider } from '../aux-window-container-context'

/**
 * Hosts a detached tab group in its own OS window.
 *
 * Same renderer, separate document: `children` are the ordinary pane tree, so
 * the store, IPC and PTY delivery are untouched. Closing the window (either
 * from here or by the user) reattaches the group to the main layout.
 */
export default function DetachedTabGroupWindow({
  groupId,
  title,
  children
}: {
  groupId: string
  title: string
  children: React.ReactNode
}): React.JSX.Element | null {
  const reattachTabGroup = useAppStore((state) => state.reattachTabGroup)
  const recordAuxWindowBounds = useAppStore((state) => state.recordAuxWindowBounds)
  const [aux, setAux] = useState<AuxPaneWindow | null>(null)

  useEffect(() => {
    const opened = openAuxPaneWindow({
      groupId,
      title,
      bounds: useAppStore.getState().auxWindowBoundsByGroupId[groupId] ?? null,
      onClose: () => reattachTabGroup(groupId),
      onBoundsChange: (bounds) => recordAuxWindowBounds(groupId, bounds)
    })
    if (!opened) {
      // Why: a blocked open must not strand the group in limbo — put it back.
      reattachTabGroup(groupId)
      return
    }
    setAux(opened)
    // Why: terminal panes live in a sibling overlay layer, not inside the group
    // body — they need this container to follow the group into the window.
    registerAuxPaneContainer(groupId, opened.container)
    return () => {
      setAux(null)
      unregisterAuxPaneContainer(groupId)
      opened.close()
    }
    // Why: reopening on a title change would tear down the pane's PTY view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId])

  useEffect(() => {
    if (aux) {
      aux.window.document.title = title
    }
  }, [aux, title])

  if (!aux) {
    return null
  }
  return createPortal(
    // Why: menus and tooltips opened inside this window must portal into it,
    // not into the main window's document.body (Radix's default).
    <AuxWindowContainerProvider value={aux.container}>{children}</AuxWindowContainerProvider>,
    aux.container
  )
}
