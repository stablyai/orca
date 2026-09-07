import { useAppStore, type AppState } from '@/store'
import {
  recordWindowPaneChange,
  reverseWindowPaneChange,
  type WindowPaneChange
} from '@/store/slices/window-pane-history'

export class WorkspaceViewTransactionHistory {
  private pending = new Map<string, WindowPaneChange>()
  private committed = new Map<string, WindowPaneChange | 'applied'>()

  stage(id: string, before: AppState, patch: Partial<AppState>): void {
    const change = recordWindowPaneChange(before, patch).workspaceLayoutHistory?.at(-1)
    if (change) {
      this.pending.set(id, change)
    }
  }

  restore(id: string): void {
    const change = this.pending.get(id)
    if (change) {
      useAppStore.setState(reverseWindowPaneChange(useAppStore.getState(), change))
    }
    this.pending.delete(id)
  }

  finish(id: string, succeeded: boolean, transaction: boolean): void {
    const change = this.pending.get(id)
    if (succeeded && change) {
      if (transaction) {
        this.committed.set(id, change)
        if (this.committed.size > 40) {
          this.committed.delete(this.committed.keys().next().value!)
        }
      }
      useAppStore.setState((state) => ({
        workspaceLayoutHistory: [
          ...state.workspaceLayoutHistory.slice(-19),
          { ...change, ...(transaction ? { transferId: id } : {}) }
        ]
      }))
    }
    this.pending.delete(id)
  }

  canUndo(id: string): boolean {
    return this.committed.has(id)
  }

  undo(id: string): boolean {
    const state = useAppStore.getState()
    const change = this.committed.get(id)
    if (!change) {
      return false
    }
    if (change === 'applied') {
      return true
    }
    useAppStore.setState({
      ...reverseWindowPaneChange(state, change),
      workspaceLayoutHistory: state.workspaceLayoutHistory.filter(
        (entry) => entry.transferId !== id
      )
    })
    this.committed.set(id, 'applied')
    return true
  }
}
