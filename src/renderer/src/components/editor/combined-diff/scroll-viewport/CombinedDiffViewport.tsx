import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { getDiffSectionRowEstimatedHeight } from '../../diff/sections/diff-section-layout'
import { CombinedDiffViewportOwner, type DiffViewportItem } from './combined-diff-viewport-owner'

const DiffRowContext = createContext<DiffViewportItem | null>(null)

export function useCombinedDiffRow(): DiffViewportItem | null {
  return useContext(DiffRowContext)
}

export function useCombinedDiffViewport(input: {
  sections: readonly DiffSection[]
  sectionHeights: Readonly<Record<number, number>>
  renderedIndicesRef?: { current: Set<number> }
  prefix?: boolean
}): CombinedDiffViewportOwner {
  const [owner] = useState(() => new CombinedDiffViewportOwner())
  useLayoutEffect(() => owner.retain(), [owner])
  useLayoutEffect(() => {
    owner.setItems([
      ...(input.prefix
        ? [
            {
              key: 'combined-diff-notice',
              generation: 'notice',
              height: 88,
              collapsed: false,
              index: -1
            }
          ]
        : []),
      ...input.sections.map((section, index) => ({
        index,
        key: section.key,
        generation: `${section.contentGeneration ?? 0}:${section.loading ? 'loading' : section.error ? 'error' : section.loadOnDemand ? 'deferred' : section.largeDiffRenderLimit?.limited ? 'limited' : (section.diffResult?.kind ?? 'text')}`,
        height: getDiffSectionRowEstimatedHeight(section, input.sectionHeights[index]),
        collapsed: section.collapsed
      }))
    ])
  }, [input.sections, input.sectionHeights, input.prefix, owner])
  useLayoutEffect(() => {
    if (!input.renderedIndicesRef) {
      return
    }
    const publish = (): void => {
      input.renderedIndicesRef!.current = new Set(
        owner
          .getSnapshot()
          .filter((item) => item.index >= 0)
          .map((item) => item.index)
      )
    }
    publish()
    return owner.subscribe(publish)
  }, [input.renderedIndicesRef, owner])
  return owner
}

function DiffViewportRow({
  item,
  children
}: {
  item: DiffViewportItem
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = ref.current!
    item.owner.setNode(item, node)
    const observer = new ResizeObserver(() => {
      if (item.binding || node.querySelector('[data-combined-diff-native]')) {
        return
      }
      const content = node.firstElementChild
      if (content instanceof HTMLElement) {
        item.owner.measure(item, content.offsetHeight)
      }
    })
    const content = node.firstElementChild
    if (content) {
      observer.observe(content)
    }
    return () => {
      observer.disconnect()
      item.owner.setNode(item, null)
    }
  }, [item])
  return (
    <DiffRowContext.Provider value={item}>
      <div
        ref={ref}
        data-combined-diff-section-row=""
        data-combined-diff-section-key={item.key}
        className="absolute left-0 top-0 w-full overflow-hidden"
      >
        {children}
      </div>
    </DiffRowContext.Provider>
  )
}

export function CombinedDiffViewport({
  owner,
  children,
  onMount
}: {
  owner: CombinedDiffViewportOwner
  children: (index: number) => ReactNode
  onMount?: (node: HTMLDivElement | null) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const items = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
  useLayoutEffect(() => {
    const dispose = owner.mount(ref.current!)
    onMount?.(owner.root)
    return () => {
      onMount?.(null)
      dispose()
    }
  }, [onMount, owner])
  return (
    <div ref={ref} className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      {createPortal(
        items.map((item) => (
          <DiffViewportRow key={item.key} item={item}>
            {children(item.index)}
          </DiffViewportRow>
        )),
        owner.scene
      )}
    </div>
  )
}
