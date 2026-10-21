import React from 'react'

// Why: provider stderr is the only thing that explains a failure or a slow start, so it gets
// the same fixed-height log surface whether the start is in progress or has failed.
export default function CreationOutputLog({
  log,
  emptyLabel,
  size = 'tall'
}: {
  log: string
  emptyLabel: string
  /** `compact` sits under a stage list, where the log is secondary. */
  size?: 'tall' | 'compact'
}): React.JSX.Element {
  const ref = React.useRef<HTMLPreElement>(null)
  // Why: follow the tail as output streams in, but stop following the moment the user scrolls up so
  // they can read earlier output. Resume following once they scroll back to the bottom.
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
      data-size={size}
      className="scrollbar-sleek h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-2xs leading-4 data-[size=compact]:h-48 text-muted-foreground"
    >
      {log || <span className="text-muted-foreground/60">{emptyLabel}</span>}
    </pre>
  )
}
