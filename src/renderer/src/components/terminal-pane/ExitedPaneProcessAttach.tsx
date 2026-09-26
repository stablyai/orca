import { useEffect, useEffectEvent, useState } from 'react'

/**
 * Attaches an exited pane to the process main started for its leaf, signalled by the leaf's layout
 * binding naming a PTY it did not name when the exit showed. Mounted only while the pane shows an
 * exit, so live panes pay nothing for it.
 */
export function ExitedPaneProcessAttach({
  boundPtyId,
  onAttach
}: {
  boundPtyId: string | null
  onAttach: () => void
}): null {
  // Why the binding at mount: a remounted exited pane can still name its dead process.
  const [ptyIdWhenExited] = useState(boundPtyId)
  const rebound = boundPtyId !== null && boundPtyId !== ptyIdWhenExited
  const attach = useEffectEvent(onAttach)
  useEffect(() => {
    if (rebound) {
      attach()
    }
  }, [rebound])
  return null
}
