import { useLayoutEffect, useState } from 'react'
import { PortalContainerContext } from './portal-container-context'

/** Why: a hidden Activity skips portals under an already-hidden host, so open overlays stay on
 *  screen with no anchor. Overlays inside portal here, and this container hides with the pane. */
export function ActivityPortalContainer({
  visible,
  children
}: {
  visible: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const node = document.createElement('div')
    node.dataset.activityPortalContainer = ''
    document.body.append(node)
    setContainer(node)
    return () => node.remove()
  }, [])
  useLayoutEffect(() => {
    // `contents` keeps body-level stacking for the overlays inside.
    container?.style.setProperty('display', visible ? 'contents' : 'none')
  }, [container, visible])
  return <PortalContainerContext value={container ?? undefined}>{children}</PortalContainerContext>
}
