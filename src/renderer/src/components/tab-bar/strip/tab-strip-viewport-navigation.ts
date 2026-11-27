import { useRef } from 'react'
import { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'

export function useTabStripViewportNavigation(
  inputs: Parameters<typeof useTabStripOverflowNavigation>[0],
  wrapTabs: boolean
) {
  const horizontal = useTabStripOverflowNavigation({ ...inputs, enabled: !wrapTabs })
  const wrappedViewport = useRef<HTMLDivElement>(null)
  return {
    ...horizontal,
    viewportRef: wrapTabs ? wrappedViewport : horizontal.tabStripRef
  }
}
