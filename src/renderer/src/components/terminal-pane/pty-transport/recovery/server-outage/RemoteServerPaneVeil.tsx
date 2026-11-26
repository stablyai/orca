import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import { nudgeRemoteServerOutageCard } from './remote-server-outage-signals'

function forwardWheelToTerminal(event: WheelEvent, terminal: Terminal): void {
  const target = terminal.element?.querySelector('.xterm-screen') ?? terminal.element
  if (!target) {
    return
  }
  // Why: only the copy may reach ancestors, or a wheel listener above the pane would run twice.
  event.stopPropagation()
  target.dispatchEvent(
    new WheelEvent('wheel', {
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      bubbles: true,
      cancelable: true,
      composed: true
    })
  )
}

/** Covers a pane whose server is down: pointer input stops here, scrollback still scrolls, and a click points at the card. */
export function RemoteServerPaneVeil({
  environmentId,
  terminal
}: {
  environmentId: string
  terminal: Terminal
}): React.JSX.Element {
  const veilRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const veil = veilRef.current
    if (!veil) {
      return
    }
    const onWheel = (event: WheelEvent): void => forwardWheelToTerminal(event, terminal)
    veil.addEventListener('wheel', onWheel, { passive: true })
    return () => veil.removeEventListener('wheel', onWheel)
  }, [terminal])
  // Why default only: propagation must still reach document listeners that dismiss open menus.
  const block = (event: React.SyntheticEvent): void => event.preventDefault()
  return (
    <div
      ref={veilRef}
      aria-hidden="true"
      data-remote-server-pane-veil={environmentId}
      // Why: the pane's own pointerdown would otherwise focus the held terminal.
      data-pane-prevent-terminal-focus=""
      className="absolute inset-0 z-30 cursor-not-allowed bg-background/55 backdrop-blur-[1.5px]"
      onPointerDown={(event) => {
        block(event)
        nudgeRemoteServerOutageCard(environmentId)
      }}
      onMouseDown={block}
      onContextMenu={block}
    />
  )
}
