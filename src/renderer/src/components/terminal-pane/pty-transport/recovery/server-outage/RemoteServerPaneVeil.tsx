import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import { nudgeRemoteServerOutageCard } from './remote-server-outage-signals'

/** Scrollback scrolling only: on the alt screen or with mouse tracking, xterm turns a wheel into keys or mouse reports, which the input hold would replay into the program when the server returns. */
function veilWheelScrollsScrollback(terminal: Terminal, event: WheelEvent): boolean {
  return (
    !event.ctrlKey &&
    terminal.buffer.active.type === 'normal' &&
    terminal.modes.mouseTrackingMode === 'none'
  )
}

function forwardWheelToTerminal(event: WheelEvent, terminal: Terminal): void {
  // Why: only the copy may reach ancestors, or a wheel listener above the pane would run twice.
  event.stopPropagation()
  const target = terminal.element?.querySelector('.xterm-screen') ?? terminal.element
  if (!target || !veilWheelScrollsScrollback(terminal, event)) {
    return
  }
  const copy = new WheelEvent('wheel', {
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
  // Why: xterm scrolls by the legacy wheelDelta fields, which a constructed WheelEvent leaves at 0.
  Object.defineProperty(copy, 'wheelDeltaX', {
    value: 'wheelDeltaX' in event ? event.wheelDeltaX : undefined
  })
  Object.defineProperty(copy, 'wheelDeltaY', {
    value: 'wheelDeltaY' in event ? event.wheelDeltaY : undefined
  })
  target.dispatchEvent(copy)
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
