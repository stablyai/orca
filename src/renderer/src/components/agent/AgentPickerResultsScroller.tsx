import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react'

/** How a host menu sizes the agent list; absent everywhere but menus that fit it to the screen. */
export type AgentPickerListFit = {
  registerList: (node: HTMLDivElement | null) => void
  /** null: no cap of its own, the host menu scrolls. */
  maxHeight: number | null
  scrollPaddingBottom: number | null
  fadeVisible: boolean
}

export const AgentPickerListFitContext = createContext<AgentPickerListFit | null>(null)

// Its own component so fit updates (e.g. the fade on scroll) never re-render the rows.
export function AgentPickerResultsScroller({ children }: { children: ReactNode }) {
  const fit = useContext(AgentPickerListFitContext)
  if (!fit) {
    return (
      <div data-agent-picker-results className="max-h-64 overflow-y-auto scrollbar-sleek">
        {children}
      </div>
    )
  }
  return <FittedResultsScroller fit={fit}>{children}</FittedResultsScroller>
}

function FittedResultsScroller({
  fit: { registerList, maxHeight, scrollPaddingBottom, fadeVisible },
  children
}: {
  fit: AgentPickerListFit
  children: ReactNode
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!node) {
      return
    }
    registerList(node)
    return () => registerList(null)
  }, [registerList, node])
  return (
    <div className="relative">
      <div
        ref={setNode}
        data-agent-picker-results
        className={maxHeight !== null ? 'overflow-y-auto scrollbar-sleek' : undefined}
        style={
          maxHeight !== null
            ? { maxHeight, scrollPaddingBottom: scrollPaddingBottom ?? undefined }
            : undefined
        }
      >
        {children}
      </div>
      {fadeVisible ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-linear-to-b from-transparent to-popover"
        />
      ) : null}
    </div>
  )
}
