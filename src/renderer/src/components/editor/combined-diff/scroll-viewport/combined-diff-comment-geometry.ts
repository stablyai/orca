import type { editor } from 'monaco-editor'
import type { DiffSemanticPoint, DiffViewportItem } from './combined-diff-viewport-owner'

type CommentGeometryContext = {
  readonly detached: boolean
  readonly item: DiffViewportItem
  chromeHeight(): number
  project(pane: editor.ICodeEditor, top: number): number | null
  resolveTop(
    pane: editor.ICodeEditor,
    projected: number | null,
    displacement: number
  ): number | null
}
export class CombinedDiffCommentGeometry {
  readonly entries = new Map<
    HTMLElement,
    {
      pane: editor.ICodeEditor
      id: string
      node: HTMLElement
      controls: () => readonly HTMLElement[]
    }
  >()
  constructor(private readonly context: CommentGeometryContext) {}
  register(
    pane: editor.ICodeEditor,
    id: string,
    node: HTMLElement,
    controls: () => readonly HTMLElement[]
  ): () => void {
    const target = { pane, id, node, controls }
    this.entries.set(node, target)
    return () => {
      if (this.entries.get(node) === target) {
        this.entries.delete(node)
      }
    }
  }
  clear(): void {
    this.entries.clear()
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
    const display = node.style.display
    const visibility = node.style.visibility
    try {
      // Native only sizes the zone container after visible whitespace; measure offscreen cards at the same current width.
      parent.style.width = `${Math.max(pane.getScrollWidth(), contentWidth)}px`
      if (display === 'none') {
        node.style.visibility = 'hidden'
        node.style.display = 'block'
      }
      return measure()
    } finally {
      node.style.display = display
      node.style.visibility = visibility
      parent.style.width = width
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
          (control) => control.isConnected && control.offsetHeight > 0
        )
        if (!zone || zone.hidden || zone.height <= 0 || targets.length === 0) {
          return null
        }
        const local = node.getBoundingClientRect()
        const bounds = targets.map((target) => target.getBoundingClientRect())
        let start = Math.min(...bounds.map((target) => target.top - local.top))
        let end = Math.max(...bounds.map((target) => target.bottom - local.top))
        if (end - start > this.context.item.owner.root.clientHeight - this.context.chromeHeight()) {
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
        pane.getViewZoneBounds(id) !== null &&
        controls().some((control) => control.isConnected && node.contains(control)),
      project: () => interval()?.[0] ?? null,
      constrainDisplacement: (height, displacement) => {
        const bounds = interval()
        if (!bounds) {
          return null
        }
        const span = bounds[1] - bounds[0]
        const chrome = this.context.chromeHeight()
        return Math.max(chrome, Math.min(displacement, height - span - 8))
      },
      revealDisplacement: (height) => {
        const bounds = interval()
        if (!bounds) {
          return null
        }
        const [top, bottom] = bounds
        const chrome = this.context.chromeHeight()
        return top < chrome
          ? chrome
          : bottom > height
            ? Math.max(chrome, height - (bottom - top) - 8)
            : top
      },
      dispose: () => {}
    }
    return point
  }
}
