import { CombinedDiffViewportAnchor, type DiffSemanticPoint } from './combined-diff-viewport-anchor'
import { CombinedDiffViewportScene } from './combined-diff-viewport-scene'
import { CombinedDiffViewportItems } from './combined-diff-viewport-items'
import { CombinedDiffExtentTransaction } from './combined-diff-extent-transaction'
import type { DiffViewportInput } from './combined-diff-viewport-items'
import type { DiffItemLayout, DiffReadingAnchor, DiffViewportLayout } from './combined-diff-layout'

export type { DiffSemanticPoint } from './combined-diff-viewport-anchor'
export type { DiffViewportItem, DiffViewportBinding } from './combined-diff-viewport-item'
import type { DiffViewportItem, DiffViewportBinding } from './combined-diff-viewport-item'

export class CombinedDiffViewportOwner {
  readonly onDispose = new Set<() => void>()
  private readonly listeners = new Set<() => void>()
  private readonly scrollListeners = new Set<() => void>()
  private readonly geometry = new CombinedDiffExtentTransaction()
  private visible: readonly DiffViewportItem[] = []
  private revision = 0
  private logicalTop = 0
  private reconciling = false
  private queued = false
  private retainRevision = 0
  private disposed = false
  private dirty = false
  private indicesChanged = false
  private direction: 'up' | 'down' | undefined
  private directionTimer = 0
  private layout = this.geometry.index.project(0, 0, 0, false)

  private readonly anchor = new CombinedDiffViewportAnchor({
    invalidate: () => this.schedule(),
    getIndex: () => this.geometry.index,
    getHeight: () => this.surface.height,
    getTop: () => this.logicalTop,
    setTop: (top) => {
      this.logicalTop = top
    },
    render: () => this.render(true),
    getDirection: () => this.direction,
    getVisible: () =>
      this.layout.items.flatMap((layout) => {
        const item = this.registry.get(layout.key)
        return item ? [item] : []
      })
  })
  private readonly registry = new CombinedDiffViewportItems(this)
  private readonly surface = new CombinedDiffViewportScene({
    invalidate: () => this.invalidate(),
    focusChanged: () => this.focusChanged(),
    scrollTo: (top) => this.input(top - this.logicalTop),
    scrollBy: (delta) => this.input(delta)
  })
  readonly scene = this.surface.scene
  readonly root = this.surface.root
  readonly overflow = this.surface.overflow
  retain(): () => void {
    this.retainRevision++
    return () => {
      const revision = ++this.retainRevision
      queueMicrotask(() => {
        if (revision === this.retainRevision) {
          this.dispose()
        }
      })
    }
  }
  mount(host: HTMLDivElement): () => void {
    return this.surface.mount(host)
  }
  getItem(key: string): DiffViewportItem | undefined {
    return this.registry.get(key)
  }
  setItems(inputs: readonly DiffViewportInput[]): void {
    const changes = this.registry.setItems(inputs)
    this.applyInputs(changes)
  }
  updateItems(inputs: readonly DiffViewportInput[]): void {
    this.applyInputs(this.registry.updateItems(inputs))
  }
  private applyInputs(changes: {
    structure: boolean
    changed: readonly DiffViewportItem[]
    indices: boolean
  }): void {
    this.indicesChanged ||= changes.indices
    this.geometry.changed(changes.changed, changes.structure)
    if (changes.structure || changes.changed.length || changes.indices) {
      this.schedule()
    }
  }
  private render(preserveSlack: boolean): void {
    this.layout = this.surface.render({
      index: this.geometry.index,
      attached: this.registry.attached,
      focused: this.registry.focused,
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
    return this.geometry.index.anchorAt(this.logicalTop)
  }
  getLayout(): DiffViewportLayout {
    return this.layout
  }
  getItemLayout(key: string): DiffItemLayout | null {
    return this.geometry.index.itemLayout(key, this.layout)
  }

  setNode(item: DiffViewportItem, node: HTMLDivElement | null): void {
    item.node = node
    this.registry.trackAttachment(item)
    this.invalidate(item)
  }
  measure(item: DiffViewportItem, height: number): void {
    if (this.geometry.measure(item, height)) {
      this.schedule()
    }
  }

  bind(item: DiffViewportItem, binding: DiffViewportBinding): () => void {
    item.binding?.detach()
    item.binding = binding
    this.registry.trackAttachment(item)
    this.invalidate(item)
    return () => {
      if (item.binding !== binding) {
        return
      }
      binding.detach()
      item.binding = null
      this.geometry.forget(item)
      this.registry.trackAttachment(item)
      this.schedule()
    }
  }

  retireItem(item: DiffViewportItem): void {
    this.cancelItemNavigation(item)
    this.geometry.forget(item)
  }
  private focusChanged(): void {
    this.registry.focusChanged()
    this.schedule()
  }
  invalidateView = (): void => {
    this.schedule()
  }
  invalidate = (item?: DiffViewportItem): void => {
    this.geometry.invalidate(item)
    this.schedule()
  }
  private schedule(): void {
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
    this.anchor.beginInput()
    if (delta !== 0) {
      this.direction = delta < 0 ? 'up' : 'down'
      clearTimeout(this.directionTimer)
      this.directionTimer = window.setTimeout(() => {
        this.direction = undefined
      }, 100)
    }
    const max = Math.max(0, this.layout.logicalHeight - this.surface.height)
    this.logicalTop = Math.max(
      -this.layout.leadingSlack,
      Math.min(this.logicalTop + delta, max + this.layout.trailingSlack)
    )
    this.reconcile()
  }

  navigate(index: number): void {
    const item = this.registry.getByIndex(index)
    if (!item) {
      return
    }
    this.cancelNavigation()
    this.anchor.clearPoint()
    this.logicalTop = this.geometry.index.anchorOffset({ key: item.key, offset: 0 }) ?? 0
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
    if (!this.surface.mounted || this.surface.height <= 0 || this.reconciling) {
      return
    }
    this.reconciling = true
    let focus: (() => void) | undefined
    try {
      if (this.geometry.pending) {
        this.commitGeometry()
      }
      this.render(!resetSlack)
      // A real native geometry notification during input promotes it before publication.
      if (this.geometry.pending) {
        this.commitGeometry()
        this.render(!resetSlack)
      }
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

  private commitGeometry(): void {
    const result = this.geometry.commit({
      order: this.registry.order,
      attached: this.registry.attached,
      scene: this.surface,
      layout: this.layout,
      top: this.logicalTop,
      height: this.surface.height,
      direction: this.direction,
      survives: (key) => this.registry.get(key) !== undefined
    })
    this.logicalTop = result.top
    if (result.changed) {
      this.revision++
    }
  }

  private publishVisible(): void {
    const visible = this.registry.visibleProjection(this.layout, this.geometry.index)
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
    if (this.disposed) {
      return
    }
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
