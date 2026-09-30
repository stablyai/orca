import { useCallback, useState } from 'react'
import type { MouseEvent } from 'react'

/** Row selection with Cmd/Ctrl-click toggling and Shift-click ranges over the visible row order. */
export function usePerforceSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)

  const select = useCallback(
    (key: string, event: MouseEvent, orderedKeys: readonly string[]): 'toggled' | 'plain' => {
      if (event.metaKey || event.ctrlKey) {
        setSelected((current) => {
          const next = new Set(current)
          if (!next.delete(key)) {
            next.add(key)
          }
          return next
        })
        setAnchor(key)
        return 'toggled'
      }
      if (event.shiftKey && anchor) {
        const from = orderedKeys.indexOf(anchor)
        const to = orderedKeys.indexOf(key)
        if (from !== -1 && to !== -1) {
          setSelected(new Set(orderedKeys.slice(Math.min(from, to), Math.max(from, to) + 1)))
          return 'toggled'
        }
      }
      setSelected(new Set([key]))
      setAnchor(key)
      return 'plain'
    },
    [anchor]
  )

  /** Right-clicking outside the selection acts on that row alone. */
  const focusForContextMenu = useCallback((key: string) => {
    setSelected((current) => (current.has(key) ? current : new Set([key])))
    setAnchor(key)
  }, [])

  return { selected, select, focusForContextMenu }
}
