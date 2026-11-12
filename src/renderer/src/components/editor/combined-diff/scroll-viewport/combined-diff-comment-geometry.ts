import type { editor } from 'monaco-editor'
import type { DiffSemanticPoint, DiffViewportItem } from './combined-diff-viewport-owner'

type CommentGeometryContext = {
  readonly detached: boolean
  readonly item: DiffViewportItem
  usableHeight(pane: editor.ICodeEditor): number
  fitRange(
    pane: editor.ICodeEditor,
    top: number | null,
    bottom: number | null,
    preferredTop: number,
    margin?: number
  ): number | null
  usableInterval(pane: editor.ICodeEditor): { top: number; bottom: number } | null
  project(pane: editor.ICodeEditor, top: number): number | null
  resolveTop(
    pane: editor.ICodeEditor,
    projected: number | null,
    displacement: number
  ): number | null
}
export class CombinedDiffCommentGeometry {
  private readonly panes = new Map<
    editor.ICodeEditor,
    Map<
      string,
      {
        pane: editor.ICodeEditor
        id: string
        node: HTMLElement
        controls: () => readonly HTMLElement[]
      }
    >
  >()
  get(pane: editor.ICodeEditor, id: string) {
    return this.panes.get(pane)?.get(id)
  }
  constructor(private readonly context: CommentGeometryContext) {}
  register(
    pane: editor.ICodeEditor,
    id: string,
    node: HTMLElement,
    controls: () => readonly HTMLElement[]
  ): () => void {
    const target = { pane, id, node, controls }
    let entries = this.panes.get(pane)
    if (!entries) {
      entries = new Map()
      this.panes.set(pane, entries)
    }
    entries.set(id, target)
    return () => {
      if (entries.get(id) === target) {
        entries.delete(id)
        if (entries.size === 0) {
          this.panes.delete(pane)
        }
      }
    }
  }
  clear(): void {
    this.panes.clear()
  }
  measureZone<T>(
    pane: editor.ICodeEditor,
    id: string,
    node: HTMLElement,
    measure: () => T
  ): T | null {
    const zone = pane.getViewZoneBounds(id)
    if (
      this.context.detached ||
      this.context.item.retired ||
      !node.isConnected ||
      !zone ||
      zone.hidden
    ) {
      return null
    }
    const parent = node.parentElement
    const contentWidth = pane.getLayoutInfo().contentWidth
    if (!parent || contentWidth <= 0) {
      return null
    }
    const width = parent.style.width
    const targetWidth = `${Math.max(pane.getScrollWidth(), contentWidth)}px`
    const prepareWidth = width !== targetWidth
    const display = node.style.display
    const visibility = node.style.visibility
    try {
      // Native only sizes the zone container after visible whitespace; measure offscreen cards at the same current width.
      if (prepareWidth) {
        parent.style.width = targetWidth
      }
      if (display === 'none') {
        node.style.visibility = 'hidden'
        node.style.display = 'block'
      }
      return measure()
    } finally {
      node.style.display = display
      node.style.visibility = visibility
      if (prepareWidth) {
        parent.style.width = width
      }
    }
  }

  zonePoint(
    pane: editor.ICodeEditor,
    id: string,
    node: HTMLElement,
    controls: () => readonly HTMLElement[]
  ): DiffSemanticPoint | null {
    const model = pane.getModel()
    if (!model || this.context.detached) {
      return null
    }
    const interval = (): readonly [number, number] | null =>
      this.measureZone(pane, id, node, () => {
        if (
          this.context.detached ||
          this.context.item.retired ||
          pane.getModel() !== model ||
          !node.isConnected
        ) {
          return null
        }
        const zone = pane.getViewZoneBounds(id)
        const targets = controls().filter(
          (control) => control.isConnected && node.contains(control) && control.offsetHeight > 0
        )
        if (!zone || zone.hidden || zone.height <= 0 || targets.length === 0) {
          return null
        }
        const local = node.getBoundingClientRect()
        const bounds = targets.map((target) => target.getBoundingClientRect())
        let start = Math.min(...bounds.map((target) => target.top - local.top))
        let end = Math.max(...bounds.map((target) => target.bottom - local.top))
        if (end - start > this.context.usableHeight(pane)) {
          start = bounds[0].top - local.top
          end = bounds[0].bottom - local.top
        }
        const top = this.context.project(pane, zone.top + start)
        const bottom = this.context.project(pane, zone.top + end)
        return top === null || bottom === null ? null : ([top, bottom] as const)
      })
    const point: DiffSemanticPoint = {
      resolveScrollTop: (displacement) =>
        this.context.resolveTop(pane, point.project(), displacement),
      isValid: () =>
        !this.context.detached &&
        !this.context.item.retired &&
        pane.getModel() === model &&
        node.isConnected &&
        (() => {
          const zone = pane.getViewZoneBounds(id)
          return zone !== null && !zone.hidden && zone.height > 0
        })() &&
        controls().some((control) => control.isConnected && node.contains(control)),
      project: () => interval()?.[0] ?? null,
      projectEnd: () => interval()?.[1] ?? null,
      fitScrollTop: (preferredTop) => {
        const bounds = interval()
        return bounds ? this.context.fitRange(pane, bounds[0], bounds[1], preferredTop, 8) : null
      },
      constrainDisplacement: (_height, displacement) => {
        const bounds = interval()
        const usable = this.context.usableInterval(pane)
        if (!bounds || !usable) {
          return null
        }
        const span = bounds[1] - bounds[0]
        const margin = Math.min(8, Math.max(0, usable.bottom - usable.top - span))
        return Math.max(usable.top, Math.min(displacement, usable.bottom - span - margin))
      },
      revealDisplacement: () => {
        const bounds = interval()
        const usable = this.context.usableInterval(pane)
        if (!bounds || !usable) {
          return null
        }
        const [top, bottom] = bounds
        const span = bottom - top
        const margin = Math.min(8, Math.max(0, usable.bottom - usable.top - span))
        return top < usable.top
          ? usable.top
          : bottom > usable.bottom
            ? Math.max(usable.top, usable.bottom - span - margin)
            : top
      },
      dispose: () => {}
    }
    return point
  }
}
