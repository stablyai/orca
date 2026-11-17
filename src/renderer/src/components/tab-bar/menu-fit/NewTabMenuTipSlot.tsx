import React, { useLayoutEffect, useState } from 'react'
import { useNewTabMenuTipRoom } from './new-tab-menu-tip-room'

/** Shows an eligible tip unless the + menu needs its room for the agent list. */
export function NewTabMenuTipSlot({
  eligible,
  children
}: {
  eligible: boolean
  children: React.ReactNode
}): React.ReactNode {
  const room = useNewTabMenuTipRoom()
  const reportTipEligible = room?.reportTipEligible
  const registerTip = room?.registerTip
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  // Nothing is reported on unmount: a search swapping the menu body away is not ineligibility.
  useLayoutEffect(() => {
    reportTipEligible?.(eligible)
  }, [reportTipEligible, eligible])
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
