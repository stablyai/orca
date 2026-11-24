import {
  createContext,
  useCallback,
  useContext,
  useRef,
  type ReactNode,
  type RefObject
} from 'react'

/** The grab target's width from the seam's outer edge, in CSS px; the panel's padding keeps 4 px clear after it. */
export const RIGHT_SIDEBAR_GUTTER_TARGET_PX = 10

type GutterResize = {
  edge: 'left' | 'right'
  startResize: (event: React.MouseEvent) => void
  /** The sidebar's outer box; its left edge is the seam's outer edge. */
  containerRef: RefObject<HTMLElement | null>
  handleRef: RefObject<HTMLElement | null>
  /** The scroller whose strip is hovered, so a stale scroller never clears a newer one's tint. */
  hoverOwnerRef: RefObject<HTMLElement | null>
}

const GutterResizeContext = createContext<GutterResize | null>(null)

export function RightSidebarGutterResizeProvider({
  value,
  children
}: {
  value: GutterResize
  children: ReactNode
}): React.JSX.Element {
  return <GutterResizeContext.Provider value={value}>{children}</GutterResizeContext.Provider>
}

type GutterResizeProps<T extends HTMLElement> = Pick<
  React.HTMLAttributes<T>,
  'onMouseDown' | 'onMouseMove' | 'onMouseLeave'
> & { ref: React.RefCallback<T> }

function setStripHover(gutter: GutterResize, element: HTMLElement, on: boolean): void {
  element.style.cursor = on ? 'col-resize' : ''
  if (on) {
    gutter.hoverOwnerRef.current = element
  } else if (gutter.hoverOwnerRef.current === element) {
    gutter.hoverOwnerRef.current = null
  } else {
    return
  }
  gutter.handleRef.current?.toggleAttribute('data-gutter-hover', on)
}

/** Lets a scroller's own left padding start the sidebar resize, so wheel and touch scrolling stay
 *  native. Spread the result on the scroller; its `ref` also fills `scrollRef`. */
export function useRightSidebarGutterResize<T extends HTMLElement>(
  scrollRef: RefObject<T | null>
): GutterResizeProps<T> {
  const gutter = useContext(GutterResizeContext)
  const hotRef = useRef<T | null>(null)
  const ref = useCallback(
    (element: T | null) => {
      scrollRef.current = element
      if (!element) {
        return
      }
      // Unmounting under a still pointer fires no mouseleave: drop the tint with the element.
      return () => {
        if (hotRef.current === element) {
          hotRef.current = null
          if (gutter) {
            setStripHover(gutter, element, false)
          }
        }
        scrollRef.current = null
      }
    },
    [gutter, scrollRef]
  )
  if (!gutter) {
    return { ref }
  }
  const inStrip = (event: React.MouseEvent<T>): boolean => {
    // Only the scroller's own padding: children keep every pointer event they receive.
    if (event.target !== event.currentTarget) {
      return false
    }
    const bounds = gutter.containerRef.current?.getBoundingClientRect()
    if (!bounds) {
      return false
    }
    const distance =
      gutter.edge === 'left' ? bounds.right - event.clientX : event.clientX - bounds.left
    return distance >= 0 && distance < RIGHT_SIDEBAR_GUTTER_TARGET_PX
  }
  const setHover = (element: T, on: boolean): void => {
    if ((hotRef.current === element) === on) {
      return
    }
    hotRef.current = on ? element : null
    setStripHover(gutter, element, on)
  }
  return {
    ref,
    onMouseDown: (event) => {
      if (event.button === 0 && inStrip(event)) {
        gutter.startResize(event)
      }
    },
    onMouseMove: (event) => {
      if (event.buttons === 0) {
        setHover(event.currentTarget, inStrip(event))
      }
    },
    onMouseLeave: (event) => setHover(event.currentTarget, false)
  }
}
