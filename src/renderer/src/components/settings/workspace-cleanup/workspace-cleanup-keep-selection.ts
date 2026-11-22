import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { cleanupChangeRowKey } from './workspace-cleanup-row-key'

/** Event-owned selection publishes constant-size snapshots without copying selected rows. */
export class WorkspaceCleanupKeepSelection {
  private readonly selected = new Map<string, WorkspaceCleanupPreviewRow>()
  private readonly visible: Map<string, WorkspaceCleanupPreviewRow>
  private readonly listeners = new Set<() => void>()
  private visibleCount = 0
  private visibleBytes = 0
  private snapshot = this.capture()

  constructor(
    rows: readonly WorkspaceCleanupPreviewRow[],
    selected: Iterable<WorkspaceCleanupPreviewRow> = []
  ) {
    this.visible = new Map(rows.map((row) => [cleanupChangeRowKey(row), row]))
    for (const row of selected) {
      this.update(row, true)
    }
    this.snapshot = this.capture()
  }
  private capture() {
    return {
      count: this.selected.size,
      visibleCount: this.visibleCount,
      visibleBytes: this.visibleBytes,
      has: (key: string) => this.selected.has(key)
    }
  }
  private update(row: WorkspaceCleanupPreviewRow, checked: boolean) {
    const key = cleanupChangeRowKey(row)
    if (checked === this.selected.has(key)) {
      return
    }
    if (checked) {
      this.selected.set(key, row)
    } else {
      this.selected.delete(key)
    }
    const visible = this.visible.get(key)
    if (visible) {
      this.visibleCount += checked ? 1 : -1
      this.visibleBytes += (checked ? 1 : -1) * (visible.sizeBytes ?? 0)
    }
  }
  toggle(row: WorkspaceCleanupPreviewRow): void {
    this.update(row, !this.has(cleanupChangeRowKey(row)))
    this.snapshot = this.capture()
    this.listeners.forEach((listener) => listener())
  }
  has(key: string): boolean {
    return this.selected.has(key)
  }
  rows(): IterableIterator<WorkspaceCleanupPreviewRow> {
    return this.selected.values()
  }
  copyFor(rows: readonly WorkspaceCleanupPreviewRow[], allowed: ReadonlySet<string>) {
    return new WorkspaceCleanupKeepSelection(
      rows,
      [...this.rows()].filter((row) => allowed.has(cleanupChangeRowKey(row)))
    )
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
