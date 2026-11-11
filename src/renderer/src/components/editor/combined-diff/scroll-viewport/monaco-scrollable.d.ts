declare module 'monaco-editor/esm/vs/base/common/scrollable.js' {
  export type ScrollPosition = { scrollTop: number; scrollLeft: number }
  export class Scrollable {
    constructor(options: {
      forceIntegerValues: boolean
      smoothScrollDuration: number
      scheduleAtNextAnimationFrame: (callback: () => void) => { dispose(): void }
    })
    onScroll(listener: (position: ScrollPosition) => void): { dispose(): void }
    setScrollDimensions(
      dimensions: { width: number; height: number; scrollHeight: number; scrollWidth: number },
      useRawScrollPositions: boolean
    ): void
    setScrollPositionNow(position: Partial<ScrollPosition>): void
    dispose(): void
  }
}

declare module 'monaco-editor/esm/vs/base/browser/ui/scrollbar/scrollableElement.js' {
  import type { Scrollable, ScrollPosition } from 'monaco-editor/esm/vs/base/common/scrollable.js'
  export class SmoothScrollableElement {
    constructor(
      element: HTMLElement,
      options: {
        vertical: number
        horizontal: number
        useShadows: boolean
        handleMouseWheel?: boolean
      },
      scrollable: Scrollable
    )
    getDomNode(): HTMLElement
    getScrollPosition(): ScrollPosition
    dispose(): void
  }
}
