import { useEffect, useLayoutEffect, useRef } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

function observeRowSizes(root: HTMLElement, elements: HTMLElement[], refresh: () => void) {
  const observer = new ResizeObserver(refresh)
  observer.observe(root)
  elements.forEach((element) => observer.observe(element))
  return observer
}

export function useAgentReorderAnimation(order: readonly string[]) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const previousRef = useRef<{
    root: HTMLDivElement
    order: readonly string[]
    tops: Map<string, number>
  } | null>(null)
  const animationsRef = useRef<Animation[]>([])
  const observedRef = useRef<{ elements: HTMLElement[]; observer: ResizeObserver | null } | null>(
    null
  )
  const reducedMotion = usePrefersReducedMotion()

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) {
      animationsRef.current.forEach((animation) => animation.cancel())
      animationsRef.current = []
      observedRef.current?.observer?.disconnect()
      observedRef.current = null
      previousRef.current = null
      return
    }
    if (reducedMotion) {
      observedRef.current?.observer?.disconnect()
      observedRef.current = null
      animationsRef.current.forEach((animation) => animation.cancel())
      animationsRef.current = []
      previousRef.current = null
      return
    }
    const previous = previousRef.current?.root === root ? previousRef.current : null
    const orderChanged =
      previous &&
      (previous.order.length !== order.length ||
        order.some((key, index) => key !== previous.order[index]))
    const elements = Array.from(
      root.querySelectorAll<HTMLElement>('[data-agent-reorder-key]')
    ).filter((element) => !element.closest('[inert]'))
    const observed = observedRef.current
    const elementsChanged =
      !observed ||
      observed.elements.length !== elements.length ||
      elements.some((element, index) => element !== observed.elements[index])
    const measure = () => {
      const measuredTops = new Map<HTMLElement, number>()
      const top = (element: HTMLElement) => {
        const cached = measuredTops.get(element)
        if (cached !== undefined) {
          return cached
        }
        const value = element.getBoundingClientRect().top
        measuredTops.set(element, value)
        return value
      }
      return new Map(
        elements.map((element) => {
          // Each lineage branch moves with its parent; only animate its own sibling displacement.
          const container =
            element.parentElement?.closest<HTMLElement>('[data-agent-reorder-key]') ?? root
          return [element.dataset.agentReorderKey ?? '', top(element) - top(container)]
        })
      )
    }
    const refresh = () => {
      if (animationsRef.current.some((animation) => animation.playState === 'running')) {
        return
      }
      const snapshot = previousRef.current
      if (snapshot?.root === root) {
        snapshot.tops = measure()
      }
    }
    if (elementsChanged || previous?.root !== root) {
      observed?.observer?.disconnect()
      const observer =
        typeof ResizeObserver === 'undefined' ? null : observeRowSizes(root, elements, refresh)
      observedRef.current = { elements, observer }
    }
    // Resize notifications refresh heights; status-only renders need no layout reads.
    if (
      previous &&
      !orderChanged &&
      !elementsChanged &&
      (observedRef.current?.observer ||
        animationsRef.current.some((animation) => animation.playState === 'running'))
    ) {
      return
    }
    const visualTops = animationsRef.current.some((animation) => animation.playState === 'running')
      ? measure()
      : null
    // Measure layout, not a transform left over from an interrupted reorder.
    animationsRef.current.forEach((animation) => animation.cancel())
    animationsRef.current = []
    const tops = measure()
    previousRef.current = { root, order, tops }
    const previousKeys = new Set(previous?.order)
    const reordered =
      previous &&
      previous.order.length === order.length &&
      order.every((key) => previousKeys.has(key)) &&
      order.some((key, index) => key !== previous.order[index])
    if (!reordered) {
      return
    }
    for (const element of elements) {
      const key = element.dataset.agentReorderKey ?? ''
      const oldTop = previous.tops.get(key)
      // The DOM has already moved; apply the remaining transform to the prior layout.
      const visualOffset = visualTops ? (visualTops.get(key) ?? 0) - (tops.get(key) ?? 0) : 0
      const from = oldTop === undefined ? undefined : oldTop + visualOffset
      const to = tops.get(key)
      if (from === undefined || to === undefined || Math.abs(from - to) < 0.5) {
        continue
      }
      if (typeof element.animate !== 'function') {
        continue
      }
      const animation = element.animate([{ translate: `0 ${from - to}px` }, { translate: '0 0' }], {
        duration: 180,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
      })
      animation.onfinish = refresh
      animationsRef.current.push(animation)
    }
  })

  useEffect(
    () => () => {
      observedRef.current?.observer?.disconnect()
      observedRef.current = null
      animationsRef.current.forEach((animation) => animation.cancel())
      animationsRef.current = []
      previousRef.current = null
    },
    []
  )
  return rootRef
}
