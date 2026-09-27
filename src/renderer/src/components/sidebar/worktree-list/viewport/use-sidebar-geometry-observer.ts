import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { RefObject } from 'react'
import type { SidebarGeometry } from '../listing/sidebar-geometry-slots'
import { readSidebarObservation, type SidebarObservation } from './sidebar-geometry-ledger'

function createSidebarObservationOwner(sample: () => void) {
  const observer = new ResizeObserver(sample)
  let observed = new Set<Element>()
  return {
    reconcile(next: Set<Element>) {
      for (const element of observed) {
        if (!next.has(element)) {
          observer.unobserve(element)
        }
      }
      for (const element of next) {
        if (!observed.has(element)) {
          observer.observe(element)
        }
      }
      observed = next
    },
    disconnect() {
      observer.disconnect()
      observed.clear()
    }
  }
}

export function useSidebarGeometryObserver(args: {
  scrollRef: RefObject<HTMLDivElement | null>
  model: SidebarGeometry
  publish: (
    samples: ReadonlyMap<string, SidebarObservation>,
    width: number,
    native: boolean
  ) => void
}): void {
  const current = useRef(args)
  const observerRef = useRef<ReturnType<typeof createSidebarObservationOwner> | null>(null)
  const collect = (native: boolean) => {
    const { scrollRef, model, publish } = current.current
    const scroller = scrollRef.current
    if (!scroller) {
      return
    }
    const samples = new Map<string, SidebarObservation>()
    for (const element of scroller.querySelectorAll<HTMLElement>('[data-sidebar-geometry-node]')) {
      const key = element.dataset.sidebarGeometryNode
      const index = key === undefined ? undefined : model.nodeByKey.get(key)
      if (index === undefined || !element.isConnected) {
        continue
      }
      const node = model.nodes[index]!
      const children =
        node.close === null
          ? null
          : (Array.from(
              element.querySelectorAll<HTMLElement>('[data-lineage-virtual-children]')
            ).find((child) => child.closest('[data-sidebar-geometry-node]') === element) ?? null)
      if (node.close !== null && !children) {
        continue
      }
      const sample = readSidebarObservation(element, children)
      if (sample) {
        samples.set(node.key, sample)
      }
    }
    publish(samples, scroller.clientWidth, native)
  }
  useLayoutEffect(() => {
    current.current = args
  })
  useLayoutEffect(() => {
    // Initial/ref/layout sampling stays outside flushSync; only native delivery owns it.
    const owner = createSidebarObservationOwner(() => collect(true))
    observerRef.current = owner
    return () => {
      owner.disconnect()
      observerRef.current = null
    }
  }, [])
  useLayoutEffect(() => {
    const scroller = args.scrollRef.current
    const observer = observerRef.current
    if (!scroller || !observer) {
      return
    }
    const next = new Set<Element>([
      scroller,
      ...scroller.querySelectorAll('[data-sidebar-geometry-node], [data-lineage-virtual-children]')
    ])
    observer.reconcile(next)
    collect(false)
  })
}

// The caller must establish an actual observation change before entering this boundary.
export function publishNativeSidebarGeometry(publish: () => void): void {
  flushSync(publish)
}
