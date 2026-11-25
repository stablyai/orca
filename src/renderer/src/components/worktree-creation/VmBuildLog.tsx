import React from 'react'

// Recipe stderr explains both slow progress and failures; retain the same fixed log surface.
export function VmBuildLog({
  log,
  emptyLabel
}: {
  log: string
  emptyLabel: string
}): React.JSX.Element {
  const ref = React.useRef<HTMLPreElement>(null)
  // Follow output until user scrolls up; resume only when they return to bottom.
  const pinnedToBottomRef = React.useRef(true)
  const handleScroll = React.useCallback((): void => {
    const el = ref.current
    if (!el) {
      return
    }
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
  }, [])
  React.useEffect(() => {
    const el = ref.current
    if (el && pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [log])
  return (
    <pre
      ref={ref}
      onScroll={handleScroll}
      className="scrollbar-sleek h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-4 text-muted-foreground"
    >
      {log || <span className="text-muted-foreground/60">{emptyLabel}</span>}
    </pre>
  )
}
