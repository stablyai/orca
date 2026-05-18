import { isTerminalLeafId, type TerminalLeafId } from '../../../../shared/stable-pane-id'
import { mintStablePaneId } from './mint-stable-pane-id'
import type { ManagedPaneInternal } from './pane-manager-types'

export class PaneIdentityRegistry {
  private leafIdByNumericId: Map<number, TerminalLeafId> = new Map()
  private numericIdByLeafId: Map<TerminalLeafId, number> = new Map()
  private publishedPaneIds: Set<number> = new Set()

  claimLeafId(leafIdHint?: string): TerminalLeafId {
    if (leafIdHint && isTerminalLeafId(leafIdHint) && !this.numericIdByLeafId.has(leafIdHint)) {
      return leafIdHint
    }
    return this.mintUnclaimedLeafId()
  }

  register(numericPaneId: number, leafId: TerminalLeafId): void {
    this.leafIdByNumericId.set(numericPaneId, leafId)
    this.numericIdByLeafId.set(leafId, numericPaneId)
  }

  release(numericPaneId: number): void {
    const leafId = this.leafIdByNumericId.get(numericPaneId)
    if (leafId) {
      this.numericIdByLeafId.delete(leafId)
    }
    this.leafIdByNumericId.delete(numericPaneId)
    this.publishedPaneIds.delete(numericPaneId)
  }

  markPublished(numericPaneId: number): void {
    this.publishedPaneIds.add(numericPaneId)
  }

  getLeafId(numericPaneId: number): TerminalLeafId | null {
    return this.leafIdByNumericId.get(numericPaneId) ?? null
  }

  getNumericIdForLeaf(leafId: string): number | null {
    if (!isTerminalLeafId(leafId)) {
      return null
    }
    return this.numericIdByLeafId.get(leafId) ?? null
  }

  getLeafIdMap(): Map<number, TerminalLeafId> {
    return new Map(this.leafIdByNumericId)
  }

  adoptPaneLeafId(numericPaneId: number, pane: ManagedPaneInternal, leafId: string): boolean {
    if (!isTerminalLeafId(leafId) || this.publishedPaneIds.has(numericPaneId)) {
      return false
    }
    const existingOwner = this.numericIdByLeafId.get(leafId)
    if (existingOwner !== undefined && existingOwner !== numericPaneId) {
      return false
    }
    this.numericIdByLeafId.delete(pane.leafId)
    this.register(numericPaneId, leafId)
    pane.leafId = leafId
    pane.stablePaneId = leafId
    pane.container.dataset.leafId = leafId
    return true
  }

  clear(): void {
    this.leafIdByNumericId.clear()
    this.numericIdByLeafId.clear()
    this.publishedPaneIds.clear()
  }

  private mintUnclaimedLeafId(): TerminalLeafId {
    let leafId: TerminalLeafId
    do {
      leafId = mintStablePaneId()
    } while (this.numericIdByLeafId.has(leafId))
    return leafId
  }
}
