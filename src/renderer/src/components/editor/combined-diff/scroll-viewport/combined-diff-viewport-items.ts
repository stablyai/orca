import type { CombinedDiffExtentIndex } from './combined-diff-extent-index'
import type { DiffViewportLayout } from './combined-diff-layout'
import type { CombinedDiffViewportOwner, DiffViewportItem } from './combined-diff-viewport-owner'

export type DiffViewportInput = Readonly<{
  key: string
  generation: string
  height: number
  collapsed: boolean
  bodyKind?: 'pending' | 'native' | 'final'
  index: number
}>
export class CombinedDiffViewportItems {
  private readonly items = new Map<string, DiffViewportItem>()
  private readonly indices = new Map<number, DiffViewportItem>()
  order: DiffViewportItem[] = []
  readonly attached = new Set<DiffViewportItem>()
  readonly focused = new Set<DiffViewportItem>()
  constructor(private readonly owner: CombinedDiffViewportOwner) {}
  get(key: string): DiffViewportItem | undefined {
    return this.items.get(key)
  }
  getByIndex(index: number): DiffViewportItem | undefined {
    return this.indices.get(index)
  }
  setItems(inputs: readonly DiffViewportInput[]): {
    structure: boolean
    changed: DiffViewportItem[]
    indices: boolean
  } {
    const structure =
      inputs.length !== this.order.length ||
      inputs.some((input, index) => {
        const item = this.order[index]
        return input.key !== item.key || input.generation !== item.generation
      })
    if (!structure) {
      return this.updateItems(inputs)
    }
    const live = new Map(inputs.map((input) => [input.key, input]))
    for (const [key, item] of this.items) {
      if (live.get(key)?.generation !== item.generation) {
        this.retire(item)
        this.items.delete(key)
      }
    }
    this.indices.clear()
    this.order = inputs.map((input) => {
      let item = this.items.get(input.key)
      if (!item) {
        item = {
          ...input,
          owner: this.owner,
          retired: false,
          measured: false,
          node: null,
          chrome: { header: null, conflict: null, body: null },
          binding: null,
          onRetire: new Set()
        }
        this.items.set(input.key, item)
      }
      this.update(item, input)
      this.indices.set(input.index, item)
      return item
    })
    return { structure: true, changed: this.order, indices: true }
  }
  updateItems(inputs: readonly DiffViewportInput[]): {
    structure: false
    changed: DiffViewportItem[]
    indices: boolean
  } {
    const changed: DiffViewportItem[] = []
    let indices = false
    for (const input of inputs) {
      const item = this.items.get(input.key)
      if (!item) {
        continue
      }
      indices ||= item.index !== input.index
      if (this.update(item, input)) {
        changed.push(item)
      }
    }
    return { structure: false, changed, indices }
  }
  private update(item: DiffViewportItem, input: DiffViewportInput): boolean {
    const height = item.collapsed !== input.collapsed || !item.measured ? input.height : item.height
    const changed =
      height !== item.height ||
      item.collapsed !== input.collapsed ||
      item.bodyKind !== input.bodyKind
    if (this.indices.get(item.index) === item) {
      this.indices.delete(item.index)
    }
    this.indices.set(input.index, item)
    item.index = input.index
    item.height = height
    if (item.collapsed !== input.collapsed) {
      item.measured = false
    }
    item.collapsed = input.collapsed
    item.bodyKind = input.bodyKind
    return changed
  }
  trackAttachment(item: DiffViewportItem): void {
    if (!item.retired && (item.node || item.binding)) {
      this.attached.add(item)
    } else {
      this.attached.delete(item)
      this.focused.delete(item)
    }
  }
  focusChanged(): void {
    const active = document.activeElement
    for (const item of this.attached) {
      if ((active && item.node?.contains(active)) || item.binding?.hasFocus()) {
        this.focused.add(item)
      } else {
        this.focused.delete(item)
      }
    }
  }
  visibleProjection(
    layout: DiffViewportLayout,
    index: CombinedDiffExtentIndex
  ): DiffViewportItem[] {
    const candidates = new Set(
      layout.items.flatMap((layout) => {
        const item = this.get(layout.key)
        return item && layout.visible ? [item] : []
      })
    )
    for (const item of this.focused) {
      if (!item.retired) {
        candidates.add(item)
      }
    }
    return [...candidates].sort(
      (left, right) => index.position(left.key)! - index.position(right.key)!
    )
  }
  private retire(item: DiffViewportItem): void {
    item.retired = true
    this.attached.delete(item)
    this.focused.delete(item)
    this.owner.retireItem(item)
    item.binding?.detach()
    item.binding = null
    for (const dispose of item.onRetire) {
      dispose()
    }
    item.onRetire.clear()
  }
  dispose(): void {
    for (const item of this.items.values()) {
      this.retire(item)
    }
    this.items.clear()
    this.indices.clear()
    this.order = []
  }
}
