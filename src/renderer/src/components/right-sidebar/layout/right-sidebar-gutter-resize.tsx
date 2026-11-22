import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react'

/** The grab target's width from the seam's outer edge, in CSS px; the panel's padding keeps 4 px clear after it. */
export const RIGHT_SIDEBAR_GUTTER_TARGET_PX = 10

type GutterResize = {
  startResize: (event: React.MouseEvent) => void
  /** The sidebar's outer box; its left edge is the seam's outer edge. */
  containerRef: RefObject<HTMLElement | null>
  handleRef: RefObject<HTMLElement | null>
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

type GutterResizeProps = Pick<
  React.HTMLAttributes<HTMLElement>,
  'onMouseDown' | 'onMouseMove' | 'onMouseLeave'
>

/** Lets a scroller's own left padding start the sidebar resize, so wheel and touch scrolling stay native. */
export function useRightSidebarGutterResize(): GutterResizeProps {
  const gutter = useContext(GutterResizeContext)
  const hoverRef = useRef(false)
  if (!gutter) {
    return {}
  }
  const inStrip = (event: React.MouseEvent<HTMLElement>): boolean => {
    // Only the scroller's own padding: children keep every pointer event they receive.
    if (event.target !== event.currentTarget) {
      return false
    }
    const seam = gutter.containerRef.current?.getBoundingClientRect().left
    return seam !== undefined && event.clientX < seam + RIGHT_SIDEBAR_GUTTER_TARGET_PX
  }
  const setHover = (element: HTMLElement, on: boolean): void => {
    if (hoverRef.current === on) {
      return
    }
    hoverRef.current = on
    element.style.cursor = on ? 'col-resize' : ''
    gutter.handleRef.current?.toggleAttribute('data-gutter-hover', on)
  }
  return {
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
