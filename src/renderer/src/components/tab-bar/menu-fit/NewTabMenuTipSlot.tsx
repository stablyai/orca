import React, { useLayoutEffect, useState } from 'react'
import { useNewTabMenuTipRoom } from './new-tab-menu-tip-room'

/** Shows an eligible tip unless the + menu gave its room to the agent list. */
export function NewTabMenuTipSlot({
  eligible,
  children
}: {
  eligible: boolean
  children: React.ReactNode
}): React.ReactNode {
  const room = useNewTabMenuTipRoom()
  const registerTip = room?.registerTip
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!registerTip || !node) {
      return
    }
    registerTip(node)
    return () => registerTip(null)
  }, [registerTip, node])
  if (!eligible || room?.tipHidden) {
    return null
  }
  // flow-root keeps the tip's top margin inside the measured box.
  return room ? (
    <div ref={setNode} className="flow-root">
      {children}
    </div>
  ) : (
    children
  )
}
