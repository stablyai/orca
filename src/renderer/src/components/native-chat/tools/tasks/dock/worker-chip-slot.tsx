import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefCallback
} from 'react'
import { createPortal } from 'react-dom'

const SLOT = 'data-native-chat-worker-chip-slot'
const Register = createContext<RefCallback<HTMLElement> | null>(null)
const Placement = createContext<HTMLElement | null>(null)
const Placed = createContext<HTMLElement | null>(null)

/** Keeps the worker chip's owner (its feed, open state, dialogs and failure line) mounted in one
 *  place while the chip itself is drawn wherever the transcript's end is now: the message list, or
 *  the placeholder shown while history loads. Either remounts (history turning ready, a /clear),
 *  and the chip moves with it rather than starting over. */
export function NativeChatWorkerChipHost({
  chip,
  children
}: {
  chip: ReactNode
  children: ReactNode
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <Register.Provider value={setSlot}>
      <Placement.Provider value={slot}>
        {children}
        {chip}
      </Placement.Provider>
    </Register.Provider>
  )
}

/** Where the chip draws: at the transcript's end, after its view. */
export function NativeChatWorkerChipSlot() {
  return <div {...{ [SLOT]: '' }} className="contents" ref={useContext(Register)} />
}

/** The slot the chip is now drawn in (null outside a host): a new one is a new place to measure.
 *  It changes only once the chip has moved there, so measuring on it reads the new place. */
export function useWorkerChipPlacement(): HTMLElement | null {
  return useContext(Placed)
}

/** Draws `children` in the current slot through one container that moves between slots, so their
 *  state survives the move. Outside a host (a fixture, a test) they draw in place. */
export function WorkerChipPortal({ children }: { children: ReactNode }) {
  const hosted = useContext(Register) !== null
  const slot = useContext(Placement)
  const [container] = useState(() => {
    const element = document.createElement('div')
    element.style.setProperty('display', 'contents')
    return element
  })
  const [placedIn, setPlacedIn] = useState<HTMLElement | null>(null)
  // The last element focused inside: a move detaches the container, which drops focus to the page,
  // so it is handed back once the container lands in its new slot.
  const focused = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const landed = (event: FocusEvent) => {
      focused.current =
        event.target instanceof HTMLElement && container.contains(event.target)
          ? event.target
          : null
    }
    // A press elsewhere (even on nothing focusable) is the user moving on; focus landing elsewhere
    // already clears it. A move's own focus loss (the old list removed) is neither.
    const pressed = (event: PointerEvent) => {
      if (!(event.target instanceof Node && container.contains(event.target))) {
        focused.current = null
      }
    }
    document.addEventListener('focusin', landed)
    document.addEventListener('pointerdown', pressed, true)
    return () => {
      document.removeEventListener('focusin', landed)
      document.removeEventListener('pointerdown', pressed, true)
    }
  }, [container])
  useLayoutEffect(() => {
    if (!hosted || !slot) {
      return
    }
    slot.appendChild(container)
    setPlacedIn(slot)
    const element = focused.current
    if (
      element?.isConnected &&
      (!document.activeElement || document.activeElement === document.body)
    ) {
      element.focus({ preventScroll: true })
    }
    return () => container.remove()
  }, [hosted, slot, container])
  if (!hosted) {
    return children
  }
  return placedIn ? (
    <Placed.Provider value={placedIn}>{createPortal(children, container)}</Placed.Provider>
  ) : null
}

/** The chip's place in the transcript's column: its slot when hosted, else its own frame. Its parent
 *  is the column (the chip's settings live there) and the element before it is the column's view. */
export function workerChipAnchor(row: Element | null | undefined): Element | null {
  const frame = row?.closest('[data-native-chat-worker-dock]') ?? null
  return frame?.closest(`[${SLOT}]`) ?? frame
}
