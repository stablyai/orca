import { monaco } from '@/lib/editor/monaco/monaco-setup'
import type { editor, IRange } from 'monaco-editor'
import {
  resolveDiffAnchorTop,
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
  capture(edge: number): DiffSemanticPoint | null {
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
    const chrome = this.chromeHeight()
    const headerHeight =
      this.item.node?.querySelector<HTMLElement>('[data-combined-diff-section-header]')
        ?.offsetHeight ?? 28
    const headerBottom =
      top + Math.max(0, Math.min(-top, item.renderedHeight - headerHeight)) + headerHeight
    const bodyTop = top + chrome
    const info = pane.getLayoutInfo()
    const scrollbar = pane.getOption(monaco.editor.EditorOption.scrollbar)
    const horizontal =
      scrollbar.horizontal !== 2 && pane.getScrollWidth() > info.contentWidth
        ? scrollbar.horizontalScrollbarSize
        : 0
    const visibleTop = Math.max(0, bodyTop, headerBottom)
    const visibleBottom = Math.min(
      this.item.owner.root.clientHeight,
      top + item.renderedHeight,
      bodyTop + info.height - horizontal
    )
    if (visibleBottom <= visibleTop) {
      return null
    }
    const coordinate = edge === 0 ? visibleTop : visibleBottom
    const nativeOffset = pane.getScrollTop() + coordinate - bodyTop
    for (const target of this.zones.entries.values()) {
      if (target.pane !== pane) {
        continue
      }
      const zone = pane.getViewZoneBounds(target.id)
      if (
        !zone ||
        zone.hidden ||
        nativeOffset < zone.top ||
        nativeOffset >= zone.top + zone.height
      ) {
        continue
      }
      const point = this.zones.zonePoint(pane, target.id, target.node, target.controls)
      if (point && point.project() !== null) {
        point.constrainDisplacement = undefined
        point.revealDisplacement = undefined
        return point
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
    return this.modelPoint(pane, model, position.lineNumber, position.column)
  }

  chromeHeight(): number {
    const node = this.item.node
    return (
      (node?.querySelector<HTMLElement>('[data-combined-diff-section-header]')?.offsetHeight ??
        28) +
      (node?.querySelector<HTMLElement>('[data-combined-diff-conflict]')?.offsetHeight ?? 0) +
      1
    )
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

  resolveTop(
    pane: editor.ICodeEditor,
    projected: number | null,
    displacement: number
  ): number | null {
    if (!this.current || projected === null || this.detached) {
      return null
    }
    const { item, viewport } = this.current
    const original = this.context.editor.getOriginalEditor()
    const modified = this.context.editor.getModifiedEditor()
    const originalOffset = original.getScrollTop()
    const modifiedOffset = modified.getScrollTop()
    const chrome = this.chromeHeight()
    return resolveDiffAnchorTop({
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
      displacement,
      originalMax: Math.max(0, original.getScrollHeight() - original.getLayoutInfo().height),
      modifiedMax: Math.max(0, modified.getScrollHeight() - modified.getLayoutInfo().height),
      originalToModified: this.context.editor.getScrollTopOffset(),
      pane: pane === original ? 'original' : 'modified'
    })
  }

  modelPoint(
    pane: editor.ICodeEditor,
    model: editor.ITextModel,
    line: number,
    column = 1,
    targetRange?: IRange
  ): DiffSemanticPoint | null {
    if (this.detached || pane.getModel() !== model) {
      return null
    }
    const end = line > model.getLineCount()
    const position = model.validatePosition({ lineNumber: line, column })
    const [id] = model.deltaDecorations(
      [],
      [
        {
          range: targetRange ?? monaco.Range.fromPositions(position),
          options: {
            description: 'combined-diff-reading-anchor',
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        }
      ]
    )
    const point: DiffSemanticPoint = {
      resolveScrollTop: (displacement) => this.resolveTop(pane, point.project(), displacement),
      isValid: () =>
        !this.detached && !this.item.retired && !model.isDisposed() && pane.getModel() === model,
      project: () => {
        if (this.detached || this.item.retired || model.isDisposed() || pane.getModel() !== model) {
          return null
        }
        const range = model.getDecorationRange(id)
        if (!range) {
          return null
        }
        return this.project(
          pane,
          end
            ? pane.getContentHeight()
            : pane.getTopForPosition(range.startLineNumber, range.startColumn)
        )
      },
      projectEnd: () => {
        if (this.detached || this.item.retired || model.isDisposed() || pane.getModel() !== model) {
          return null
        }
        const range = model.getDecorationRange(id)
        return range
          ? this.project(
              pane,
              pane.getTopForPosition(range.endLineNumber, range.endColumn) +
                pane.getOption(monaco.editor.EditorOption.lineHeight)
            )
          : null
      },
      dispose: () => {
        if (!model.isDisposed()) {
          model.deltaDecorations([id], [])
        }
      }
    }
    return point
  }
}
