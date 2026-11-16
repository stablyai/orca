import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { installPierreContextualCopy } from './pierre-diff-context-copy'

// Why: Monaco's diff panes owned `editor.copyContext`; restore it for Pierre rows.
export function usePierreDiffContextCopy(
  containerRef: RefObject<HTMLElement | null>,
  filePath: string,
  language: string | undefined
): void {
  const fileInfoRef = useRef({ relativePath: filePath, language: language ?? '' })
  useLayoutEffect(() => {
    fileInfoRef.current = { relativePath: filePath, language: language ?? '' }
  }, [filePath, language])
  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }
    return installPierreContextualCopy(node, () => fileInfoRef.current)
  }, [containerRef])
}
