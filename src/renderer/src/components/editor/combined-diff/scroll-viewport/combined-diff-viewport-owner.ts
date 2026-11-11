import { CombinedDiffViewportAnchor, type DiffSemanticPoint } from './combined-diff-viewport-anchor'
import { CombinedDiffViewportScene } from './combined-diff-viewport-scene'
import { CombinedDiffViewportItems } from './combined-diff-viewport-items'
import {
  diffAnchorAt,
  diffAnchorOffset,
  layoutDiffViewport,
  mapDiffViewportTop,
  type DiffItemExtent,
  type DiffItemLayout,
  type DiffReadingAnchor,
  type DiffViewportLayout
} from './combined-diff-layout'

export type { DiffSemanticPoint } from './combined-diff-viewport-anchor'
export type DiffViewportBinding = {
  apply(layout: DiffItemLayout, viewport: DiffViewportLayout, width: number): void
  readHeight(): number | null
  capture(edge: number): DiffSemanticPoint | null
  hasFocus(): boolean
  detach(): void
}
export type DiffViewportItem = {
  readonly key: string
  readonly generation: string
  readonly owner: CombinedDiffViewportOwner
  index: number
  height: number
  collapsed: boolean
  measured: boolean
  retired: boolean
  node: HTMLDivElement | null
  binding: DiffViewportBinding | null
  readonly onRetire: Set<() => void>
}

export class CombinedDiffViewportOwner {
  readonly onDispose = new Set<() => void>()
  private readonly listeners = new Set<() => void>()
  private readonly scrollListeners = new Set<() => void>()
  private extents: DiffItemExtent[] = []
  private visible: readonly DiffViewportItem[] = []
  private revision = 0
  private logicalTop = 0
  private reconciling = false
  private queued = false
  private disposed = false
  private dirty = false
  private indicesChanged = false
  private direction: 'up' | 'down' | undefined
  private directionTimer = 0
  private layout = layoutDiffViewport({ items: [], height: 0, logicalTop: 0, revision: 0 })

  private readonly anchor = new CombinedDiffViewportAnchor({
    invalidate: () => this.invalidate(),
    getExtents: () => this.extents,
    getHeight: () => this.height,
    getTop: () => this.logicalTop,
    setTop: (top) => {
      this.logicalTop = top
    },
    render: () => this.render(true),
    getDirection: () => this.direction,
    getOrder: () => this.order
  })
  private readonly registry = new CombinedDiffViewportItems(this)
  private readonly surface = new CombinedDiffViewportScene({
    invalidate: () => this.invalidate(),
    scrollTo: (top) => this.input(top - this.logicalTop),
    scrollBy: (delta) => this.input(delta),
    unmount: () => this.dispose()
  })
  get scene(): HTMLDivElement {
    return this.surface.scene
  }
  get root(): HTMLDivElement {
    return this.surface.root
  }
  get overflow(): HTMLDivElement {
    return this.surface.overflow
  }
  private get width(): number {
    return this.surface.width
  }
  private get height(): number {
    return this.surface.height
  }
  private get order(): readonly DiffViewportItem[] {
    return this.registry.order
  }
  retain(): () => void {
    return this.surface.retain()
  }
  mount(host: HTMLDivElement): () => void {
    return this.surface.mount(host)
  }
  setItems(
    inputs: readonly {
      key: string
      generation: string
      height: number
      collapsed: boolean
      index: number
    }[]
  ): void {
    this.indicesChanged = this.registry.setItems(inputs) || this.indicesChanged
    this.invalidate()
  }
  private render(preserveSlack: boolean): void {
    this.layout = this.surface.render({
      extents: this.extents,
      order: this.order,
      logicalTop: this.logicalTop,
      revision: this.revision,
      preserveSlack
    })
    this.logicalTop = this.layout.logicalTop
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = (): readonly DiffViewportItem[] => this.visible
  subscribeScroll(listener: () => void): () => void {
    this.scrollListeners.add(listener)
    return () => this.scrollListeners.delete(listener)
  }
  getScrollTop(): number {
    return this.layout.logicalTop
  }
  getAnchor(): DiffReadingAnchor | null {
    return diffAnchorAt(this.extents, this.logicalTop)
  }
  getLayout(): DiffViewportLayout {
    return this.layout
  }
  getHeights(): Record<string, number> {
    return Object.fromEntries(this.order.map((item) => [item.key, item.height]))
  }

  setNode(item: DiffViewportItem, node: HTMLDivElement | null): void {
    item.node = node
    this.invalidate()
  }
  measure(item: DiffViewportItem, height: number): void {
    if (item.retired || height <= 0 || height === item.height) {
      return
    }
    item.height = height
    item.measured = true
    this.invalidate()
  }
  bind(item: DiffViewportItem, binding: DiffViewportBinding): () => void {
    item.binding?.detach()
    item.binding = binding
    this.invalidate()
    return () => {
      if (item.binding !== binding) {
        return
      }
      binding.detach()
      item.binding = null
      this.invalidate()
    }
  }

  invalidate = (): void => {
    this.dirty = true
    if (this.queued || this.reconciling || this.disposed) {
      return
    }
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (!this.disposed && this.dirty) {
        this.reconcile()
      }
    })
  }

  input(delta: number): void {
    this.cancelNavigation()
    this.anchor.clearPoint()
    if (delta !== 0) {
      this.direction = delta < 0 ? 'up' : 'down'
      clearTimeout(this.directionTimer)
      this.directionTimer = window.setTimeout(() => {
        this.direction = undefined
      }, 100)
    }
    const max = Math.max(0, this.layout.logicalHeight - this.height)
    this.logicalTop = Math.max(
      -this.layout.leadingSlack,
      Math.min(this.logicalTop + delta, max + this.layout.trailingSlack)
    )
    this.reconcile()
  }

  navigate(index: number): void {
    const item = this.order.find((item) => item.index === index)
    if (!item) {
      return
    }
    this.cancelNavigation()
    this.anchor.clearPoint()
    this.logicalTop = diffAnchorOffset(this.extents, { key: item.key, offset: 0 }) ?? 0
    this.reconcile(true)
  }

  importView(anchor: DiffReadingAnchor | null, fallback: number): void {
    this.anchor.importView(anchor, fallback)
  }
  preserve(point: DiffSemanticPoint, displacement = point.project()): void {
    this.anchor.preserve(point, displacement)
  }
  reveal(
    item: DiffViewportItem,
    resolve: () => DiffSemanticPoint | null,
    focus?: () => void,
    point?: DiffSemanticPoint
  ): void {
    this.anchor.reveal(item, resolve, focus, point)
  }
  cancelNavigation(): void {
    this.anchor.cancelNavigation()
  }
  cancelItemNavigation(item: DiffViewportItem): void {
    this.anchor.cancelItemNavigation(item)
  }

  private reconcile(resetSlack = false): void {
    if (!this.surface.mounted || this.height <= 0 || this.reconciling) {
      return
    }
    this.reconciling = true
    let focus: (() => void) | undefined
    try {
      const previous = this.extents
      const previousTop = this.logicalTop
      const prepare = (): void => {
        this.extents = this.order.map((item) => ({ key: item.key, height: item.height }))
        this.logicalTop = mapDiffViewportTop({
          previous,
          next: this.extents,
          top: previousTop,
          height: this.height,
          direction: this.direction
        })
        this.render(!resetSlack)
      }
      prepare()
      for (const item of this.order) {
        const height = item.binding?.readHeight()
        if (height !== null && height !== undefined && height > 0) {
          item.height = height
          item.measured = true
        }
      }
      // Width/options have drained; height-only layout cannot rewrap with minimap and scroll-beyond disabled.
      this.revision++
      prepare()
      focus = this.anchor.reconcile()
      // Notifications from the synchronous native work above are represented by this commit.
      this.dirty = false
    } finally {
      this.reconciling = false
    }
    this.publishVisible()
    this.publishScroll()
    focus?.()
  }

  private publishVisible(): void {
    const visible = this.order.filter(
      (item, index) => this.layout.items[index]?.visible || item.binding?.hasFocus()
    )
    if (
      this.indicesChanged ||
      visible.length !== this.visible.length ||
      visible.some((item, index) => item !== this.visible[index])
    ) {
      this.indicesChanged = false
      this.visible = visible
      for (const listener of this.listeners) {
        listener()
      }
    }
  }

  private publishScroll(): void {
    for (const listener of this.scrollListeners) {
      listener()
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelNavigation()
    this.anchor.clearPoint()
    this.registry.dispose()
    for (const dispose of this.onDispose) {
      dispose()
    }
    this.onDispose.clear()
    clearTimeout(this.directionTimer)
    this.surface.dispose()
    this.listeners.clear()
    this.scrollListeners.clear()
  }
}
