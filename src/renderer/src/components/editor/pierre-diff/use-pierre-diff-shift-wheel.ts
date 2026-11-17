import { revealCombinedDiffCursor } from '../combined-diff/scroll-viewport/combined-diff-cursor-reveal'
import { getShadowRootSelection } from '@/lib/shadow-root-selection'
import { useCallback, useEffect, useRef } from 'react'
import type { PostRenderPhase } from '@pierre/diffs'
import { installPaneHorizontalWheelScroll } from '../diff/monaco-view/diff-editor-horizontal-wheel-scroll'
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
      installPaneHorizontalWheelScroll({
        getContainerDomNode: () => node,
        getScrollLeft: () => instance.getCodeScrollLeft(),
        setScrollLeft: (value) => instance.setCodeScrollLeft(value),
        getScrollWidth: () => node.scrollWidth,
        getLayoutInfo: () => ({ contentWidth: node.clientWidth })
      })
    )
    let cursorFrame: number | null = null
    const revealCursor = (event: KeyboardEvent): void => {
      if (
        event.isComposing ||
        cursorFrame !== null ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (![
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'Backspace',
          'Delete',
          'Enter',
          'Tab'
        ].includes(event.key) &&
          event.key.length !== 1)
      ) {
        return
      }
      cursorFrame = requestAnimationFrame(() => {
        cursorFrame = null
        const caret = host.shadowRoot?.querySelector<HTMLElement>(
          '[data-caret][style*="scroll-margin"]'
        )
        if (caret) {
          revealCombinedDiffCursor(host, caret.getBoundingClientRect())
          return
        }
        const selection = getShadowRootSelection(host.shadowRoot)
        if (!selection?.focusNode || !host.shadowRoot?.contains(selection.focusNode)) {
          return
        }
        const range = document.createRange()
        range.setStart(selection.focusNode, selection.focusOffset)
        range.collapse(true)
        const rect = range.getBoundingClientRect()
        if (rect.height > 0) {
          revealCombinedDiffCursor(host, rect)
        }
      })
    }
    host.addEventListener('keydown', revealCursor)
    cleanups.push(() => {
      host.removeEventListener('keydown', revealCursor)
      if (cursorFrame !== null) {
        cancelAnimationFrame(cursorFrame)
      }
    })
    state.current = { nodes, cleanup: () => cleanups.forEach((cleanup) => cleanup()) }
  }, [])
}
