import { monaco } from '@/lib/editor/monaco/monaco-setup'
import type { editor, IRange } from 'monaco-editor'
import {
  resolveDiffAnchorTop,
  fitDiffAnchorRange,
  type DiffItemLayout,
  type DiffViewportLayout
} from './combined-diff-layout'
import type { DiffSemanticPoint, DiffViewportItem } from './combined-diff-viewport-owner'
import { CombinedDiffCommentGeometry } from './combined-diff-comment-geometry'

type NativeAnchorContext = {
  item: DiffViewportItem
  editor: editor.IStandaloneDiffEditor
  isDetached(): boolean
  getCurrent(): { item: DiffItemLayout; viewport: DiffViewportLayout } | null
}
export class CombinedDiffNativeAnchor {
  private readonly modelPoints = new WeakMap<
    DiffSemanticPoint,
    {
      pane: editor.ICodeEditor
      model: editor.ITextModel
      tracked: ReturnType<editor.ITextModel['createTrackedRange']>
      end: boolean
    }
  >()
  readonly zones = new CombinedDiffCommentGeometry(this)
  constructor(private readonly context: NativeAnchorContext) {}
  get item(): DiffViewportItem {
    return this.context.item
  }
  get detached(): boolean {
    return this.context.isDetached()
  }
  private get current(): { item: DiffItemLayout; viewport: DiffViewportLayout } | null {
    return this.context.getCurrent()
  }
  capture(edge: number, previous?: DiffSemanticPoint): DiffSemanticPoint | null {
    if (!this.current || this.detached) {
      return null
    }
    const { item, viewport } = this.current
    const top = item.renderedStart - viewport.renderedTop
    if (top >= this.item.owner.root.clientHeight || top + item.renderedHeight <= 0) {
      return null
    }
    const pane = this.context.editor.getModifiedEditor()
    const model = pane.getModel()
    if (!model) {
      return null
    }
    const usable = this.usableInterval(pane)
    if (!usable) {
      return null
    }
    const { top: visibleTop, bottom: visibleBottom, bodyTop } = usable
    const coordinate = edge === 0 ? visibleTop : visibleBottom
    const nativeOffset = pane.getScrollTop() + coordinate - bodyTop
    const zone = pane.getViewZoneAtVerticalOffset(nativeOffset, edge === 0 ? 'after' : 'before')
    const target = zone && !zone.hidden ? this.zones.get(pane, zone.id) : null
    if (target) {
      const point = this.zones.zonePoint(pane, target.id, target.node, target.controls)
      const projected = point?.project()
      if (point && projected !== null && projected !== undefined) {
        return this.readingPoint(point, edge, projected)
      }
    }
    const position = pane.getPositionAtVerticalOffset(nativeOffset, edge === 0 ? 'after' : 'before')
    if (!position) {
      return null
    }
    const projected = this.project(
      pane,
      pane.getTopForPosition(position.lineNumber, position.column)
    )
    if (
      projected === null ||
      projected >= visibleBottom ||
      projected + pane.getOption(monaco.editor.EditorOption.lineHeight) <= visibleTop
    ) {
      return null
    }
    const point = this.modelPoint(
      pane,
      model,
      position.lineNumber,
      position.column,
      undefined,
      previous
    )
    return point ? this.readingPoint(point, edge, projected) : null
  }

  private readingPoint(
    point: DiffSemanticPoint,
    edge: number,
    projected: number
  ): DiffSemanticPoint {
    const chrome = this.chromeHeight()
    const height = this.item.owner.root.clientHeight
    point.revealDisplacement = undefined
    point.fitScrollTop = undefined
    point.constrainDisplacement = () =>
      projected +
      (edge === 0 ? this.chromeHeight() - chrome : this.item.owner.root.clientHeight - height)
    return point
  }

  chromeHeight(): number {
    const chrome = this.item.chrome
    return (chrome?.header?.offsetHeight ?? 28) + (chrome?.conflict?.offsetHeight ?? 0)
  }

  usableInterval(
    pane: editor.ICodeEditor
  ): { top: number; bottom: number; bodyTop: number } | null {
    if (!this.current || this.detached || this.item.retired) {
      return null
    }
    const { item, viewport } = this.current
    const rowTop = item.renderedStart - viewport.renderedTop
    const headerHeight = this.item.chrome?.header?.offsetHeight ?? 28
    const headerBottom =
      rowTop + Math.max(0, Math.min(-rowTop, item.renderedHeight - headerHeight)) + headerHeight
    const bodyTop = rowTop + this.chromeHeight()
    const info = pane.getLayoutInfo()
    const scrollbar = pane.getOption(monaco.editor.EditorOption.scrollbar)
    const horizontal =
      scrollbar.horizontal !== 2 && pane.getScrollWidth() > info.contentWidth
        ? scrollbar.horizontalScrollbarSize
        : 0
    const top = Math.max(0, bodyTop, headerBottom)
    const bottom = Math.min(
      this.item.owner.root.clientHeight,
      rowTop + item.renderedHeight,
      bodyTop + info.height - horizontal
    )
    return bottom > top ? { top, bottom, bodyTop } : null
  }
  project(pane: editor.ICodeEditor, top: number): number | null {
    if (!this.current || this.detached || this.item.retired) {
      return null
    }
    const original = this.context.editor.getOriginalEditor()
    const originalOffset = original.getScrollTop()
    const modifiedOffset = this.context.editor.getModifiedEditor().getScrollTop()
    return (
      this.current.item.renderedStart -
      this.current.viewport.renderedTop +
      this.chromeHeight() +
      top -
      (pane === original ? originalOffset : modifiedOffset)
    )
  }

  private geometry(pane: editor.ICodeEditor, projected: number | null) {
    if (!this.current || projected === null || this.detached) {
      return null
    }
    const { item, viewport } = this.current
    const original = this.context.editor.getOriginalEditor()
    const modified = this.context.editor.getModifiedEditor()
    const originalOffset = original.getScrollTop()
    const modifiedOffset = modified.getScrollTop()
    const chrome = this.chromeHeight()
    return {
      start: item.start,
      height: item.height,
      renderedHeight: item.renderedHeight,
      currentTop: viewport.logicalTop,
      nativeTarget:
        projected -
        (item.renderedStart - viewport.renderedTop) -
        chrome +
        (pane === original ? originalOffset : modifiedOffset),
      chrome,
      originalMax: Math.max(0, original.getScrollHeight() - original.getLayoutInfo().height),
      modifiedMax: Math.max(0, modified.getScrollHeight() - modified.getLayoutInfo().height),
      originalToModified: this.context.editor.getScrollTopOffset(),
      pane: pane === original ? ('original' as const) : ('modified' as const)
    }
  }

  resolveTop(
    pane: editor.ICodeEditor,
    projected: number | null,
    displacement: number
  ): number | null {
    const geometry = this.geometry(pane, projected)
    return geometry ? resolveDiffAnchorTop({ ...geometry, displacement }) : null
  }

  usableHeight(pane: editor.ICodeEditor): number {
    const info = pane.getLayoutInfo()
    const scrollbar = pane.getOption(monaco.editor.EditorOption.scrollbar)
    const horizontal =
      scrollbar.horizontal !== 2 && pane.getScrollWidth() > info.contentWidth
        ? scrollbar.horizontalScrollbarSize
        : 0
    return Math.max(0, info.height - horizontal)
  }

  fitRange(
    pane: editor.ICodeEditor,
    top: number | null,
    bottom: number | null,
    preferredTop: number,
    margin = 0
  ): number | null {
    const geometry = this.geometry(pane, top)
    if (!geometry || top === null || bottom === null) {
      return null
    }
    const capacity = this.usableHeight(pane)
    const span = Math.min(bottom - top, capacity)
    return fitDiffAnchorRange({
      ...geometry,
      preferredTop,
      nativeEnd: geometry.nativeTarget + span,
      viewportHeight: this.item.owner.root.clientHeight,
      nativeHeight: capacity,
      headerHeight: this.item.chrome?.header?.offsetHeight ?? 28,
      margin: Math.min(margin, Math.max(0, capacity - span))
    })
  }

  modelPoint(
    pane: editor.ICodeEditor,
    model: editor.ITextModel,
    line: number,
    column = 1,
    targetRange?: IRange,
    previous?: DiffSemanticPoint
  ): DiffSemanticPoint | null {
    if (this.detached || pane.getModel() !== model) {
      return null
    }
    const end = line > model.getLineCount()
    const position = model.validatePosition({ lineNumber: line, column })
    const range = targetRange ?? monaco.Range.fromPositions(position)
    const old = previous ? this.modelPoints.get(previous) : undefined
    if (previous && old && old.pane === pane && old.model === model && old.tracked.getRange()) {
      old.tracked.setRange(range)
      old.end = end
      previous.fitScrollTop = undefined
      previous.revealDisplacement = undefined
      previous.constrainDisplacement = undefined
      return previous
    }
    const tracked = model.createTrackedRange(
      range,
      monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
    )
    const state = { pane, model, tracked, end }
    const point: DiffSemanticPoint = {
      resolveScrollTop: (displacement) => this.resolveTop(pane, point.project(), displacement),
      isValid: () =>
        !this.detached &&
        !this.item.retired &&
        !model.isDisposed() &&
        pane.getModel() === model &&
        tracked.getRange() !== null,
      project: () => {
        if (this.detached || this.item.retired || model.isDisposed() || pane.getModel() !== model) {
          return null
        }
        const range = tracked.getRange()
        if (!range) {
          return null
        }
        return this.project(
          pane,
          state.end
            ? pane.getContentHeight()
            : pane.getTopForPosition(range.startLineNumber, range.startColumn)
        )
      },
      projectEnd: () => {
        if (this.detached || this.item.retired || model.isDisposed() || pane.getModel() !== model) {
          return null
        }
        const range = tracked.getRange()
        return range
          ? this.project(
              pane,
              pane.getTopForPosition(range.endLineNumber, range.endColumn) +
                pane.getOption(monaco.editor.EditorOption.lineHeight)
            )
          : null
      },
      dispose: () => tracked.dispose()
    }
    this.modelPoints.set(point, state)
    return point
  }
}
