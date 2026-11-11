import type { CombinedDiffViewportOwner, DiffViewportItem } from './combined-diff-viewport-owner'

export class CombinedDiffViewportItems {
  private readonly items = new Map<string, DiffViewportItem>()
  order: DiffViewportItem[] = []
  constructor(private readonly owner: CombinedDiffViewportOwner) {}
  setItems(
    inputs: readonly {
      key: string
      generation: string
      height: number
      collapsed: boolean
      index: number
    }[]
  ): boolean {
    let indicesChanged = false
    const live = new Set(inputs.map((item) => item.key))
    const byKey = new Map(inputs.map((item) => [item.key, item]))
    for (const [key, item] of this.items) {
      const input = byKey.get(key)
      if (!live.has(key) || input?.generation !== item.generation) {
        this.retire(item)
        this.items.delete(key)
      }
    }
    this.order = inputs.map((input) => {
      let item = this.items.get(input.key)
      if (!item) {
        item = {
          ...input,
          index: input.index,
          owner: this.owner,
          retired: false,
          measured: false,
          node: null,
          binding: null,
          onRetire: new Set()
        }
        this.items.set(input.key, item)
      }
      if (item.index !== input.index) {
        indicesChanged = true
      }
      item.index = input.index
      if (item.collapsed !== input.collapsed || !item.measured) {
        item.height = input.height
      }
      item.collapsed = input.collapsed
      return item
    })
    return indicesChanged
  }
  private retire(item: DiffViewportItem): void {
    item.retired = true
    this.owner.cancelItemNavigation(item)
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
    this.order = []
  }
}
