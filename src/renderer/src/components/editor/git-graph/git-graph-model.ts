import {
  appendGitHistoryViewModels,
  buildDefaultGitHistoryColorMap,
  getGitHistoryLabelColor,
  type GitHistoryGraphState,
  type GitHistoryItemViewModel
} from '../../../../../shared/git/history/git-history-graph'
import type {
  GitHistoryGraphColorId,
  GitHistoryItem,
  GitHistoryResult
} from '../../../../../shared/git/history/git-history-types'

// Owned by a mounted pane; callers publish immutable input arrays.
export class GitGraphModel {
  rows: GitHistoryItemViewModel[] = []
  maxWidth = 132
  private items: GitHistoryItem[] = []
  private index = new Map<string, { item: GitHistoryItem; index: number }>()
  private pending = new Set<string>()
  private state: GitHistoryGraphState = { colorIndex: -1, frontier: [] }
  private colors = new Map<string, GitHistoryGraphColorId | undefined>()
  private refs: (string | undefined)[] = []

  find(id: string | undefined): { item: GitHistoryItem; index: number } | undefined {
    return id === undefined ? undefined : this.index.get(id)
  }

  private snapshot(selectedId?: string, revealId?: string) {
    return {
      rows: this.rows,
      maxWidth: this.maxWidth,
      selected: this.find(selectedId)?.item,
      revealIndex: this.find(revealId)?.index
    }
  }

  update(result: GitHistoryResult | undefined, selectedId?: string, revealId?: string) {
    const items = result?.items ?? []
    const colors = buildDefaultGitHistoryColorMap(result ?? {})
    const refs = [result?.currentRef?.id, result?.currentRef?.revision]
    const sameConfig =
      refs.every((ref, i) => ref === this.refs[i]) &&
      colors.size === this.colors.size &&
      [...colors].every(([id, color]) => this.colors.has(id) && this.colors.get(id) === color)
    if (items === this.items && sameConfig) {
      return this.snapshot(selectedId, revealId)
    }

    let append =
      sameConfig &&
      items.length >= this.items.length &&
      this.items.every((item, i) => item === items[i])
    let start = append ? this.items.length : 0
    if (append && start === items.length) {
      this.items = items
      return this.snapshot(selectedId, revealId)
    }
    if (append) {
      for (let i = start; i < items.length; i++) {
        const item = items[i]!
        if (this.pending.has(item.id) && getGitHistoryLabelColor(item, colors)) {
          append = false
          start = 0
          break
        }
      }
    }
    if (!append || items.length === 0) {
      this.rows = []
      this.maxWidth = 132
      this.index.clear()
      this.pending.clear()
      this.state = { colorIndex: -1, frontier: [] }
    }
    for (let i = start; i < items.length; i++) {
      const item = items[i]!
      if (!this.index.has(item.id)) {
        this.index.set(item.id, { item, index: i })
      }
      this.pending.delete(item.id)
    }
    const added = appendGitHistoryViewModels(
      items.slice(start),
      this.state,
      (id) => {
        const item = this.index.get(id)?.item
        if (!item) {
          this.pending.add(id)
        }
        return item
      },
      colors,
      result?.currentRef
    )
    for (const row of added) {
      this.maxWidth = Math.max(
        this.maxWidth,
        (Math.max(row.inputSwimlanes.length, row.outputSwimlanes.length) + 1) * 11
      )
    }
    this.rows = start ? this.rows.concat(added) : added
    this.items = items
    this.colors = colors
    this.refs = refs
    return this.snapshot(selectedId, revealId)
  }
}
