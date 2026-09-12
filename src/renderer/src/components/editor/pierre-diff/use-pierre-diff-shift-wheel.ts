import { useCallback, useEffect, useRef } from 'react'
import type { PostRenderPhase } from '@pierre/diffs'
import { installPaneShiftWheelScroll } from '../diff-editor-shift-wheel-scroll'
import type { PierreDiffInstance } from './PierreDiffSurface'

export function usePierreDiffShiftWheel() {
  const state = useRef<{ nodes: HTMLElement[]; cleanup: () => void }>({
    nodes: [],
    cleanup: () => {}
  })
  useEffect(
    () => () => {
      state.current.cleanup()
      state.current = { nodes: [], cleanup: () => {} }
    },
    []
  )
  return useCallback((host: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => {
    const nodes =
      phase === 'unmount'
        ? []
        : [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]') ?? [])]
    if (
      nodes.length === state.current.nodes.length &&
      nodes.every((node, index) => node === state.current.nodes[index])
    ) {
      return
    }
    state.current.cleanup()
    const cleanups = nodes.map((node) =>
      installPaneShiftWheelScroll({
        getContainerDomNode: () => node,
        getScrollLeft: () => instance.getCodeScrollLeft(),
        setScrollLeft: (value) => instance.setCodeScrollLeft(value),
        getScrollWidth: () => node.scrollWidth,
        getLayoutInfo: () => ({ contentWidth: node.clientWidth })
      })
    )
    state.current = { nodes, cleanup: () => cleanups.forEach((cleanup) => cleanup()) }
  }, [])
}
