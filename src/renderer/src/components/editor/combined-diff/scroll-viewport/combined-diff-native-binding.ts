import { CombinedDiffNativeAnchor } from './combined-diff-native-anchor'
import { monaco } from '@/lib/editor/monaco/monaco-setup'
import type { editor, IDisposable, IRange } from 'monaco-editor'
import { DIFF_SECTION_PADDING_HEIGHT } from '../../diff/sections/diff-section-layout'
import {
  diffRevealDisplacement,
  type DiffItemLayout,
  type DiffViewportLayout
} from './combined-diff-layout'
import type { DiffEditorTemplate, RetainedDiffItem } from './combined-diff-editor-pool'
import { registerCombinedEditorGeometry } from './combined-diff-editor-geometry'
import { isCombinedDiffScrollApplied, readCombinedDiffHeight } from './combined-diff-native-metrics'
import type {
  DiffSemanticPoint,
  DiffViewportBinding,
  DiffViewportItem
} from './combined-diff-viewport-owner'

let nextBindingId = 0
export class CombinedDiffNativeBinding implements DiffViewportBinding {
  readonly identity = `combined-diff-binding:${++nextBindingId}`
  private readonly onUnbind = new Set<() => void>()
  private readonly subscriptions: IDisposable[] = []
  private readonly cleanups: (() => void)[] = []
  private detached = false
  private applying = false
  private width = -1
  private nativeHeight = -1
  private current: { item: DiffItemLayout; viewport: DiffViewportLayout } | null = null
  private readonly anchors: CombinedDiffNativeAnchor
  private options: editor.IDiffEditorConstructionOptions
  private originalOptions: editor.IDiffEditorConstructionOptions | null = null

  constructor(
    private readonly item: DiffViewportItem,
    private readonly template: DiffEditorTemplate,
    private readonly record: RetainedDiffItem,
    options: editor.IDiffEditorConstructionOptions,
    private readonly body: HTMLDivElement,
    private readonly release: () => void
  ) {
    this.options = options
    this.anchors = new CombinedDiffNativeAnchor({
      item,
      editor: template.editor,
      isDetached: () => this.detached,
      getCurrent: () => this.current
    })
    const diff = template.editor
    diff.updateOptions({ ...options, automaticLayout: false })
    diff.setModel(record.viewModel)
    if (record.viewState) {
      diff.restoreViewState(record.viewState)
    }
    body.append(template.node)
    const invalidate = (): void => {
      if (!this.detached) {
        item.owner.invalidate(item)
      }
    }
    this.subscriptions.push(record.viewModel.onDidChangeDiffState(invalidate))
    this.subscriptions.push(
      diff.setGeometryDelegate({
        onDidInvalidateGeometry: invalidate,
        runWithScrollAnchor: (anchor, update) => {
          const pane =
            anchor.pane === 'original' ? diff.getOriginalEditor() : diff.getModifiedEditor()
          if (pane.getModel() === anchor.model) {
            const point = this.anchors.modelPoint(pane, anchor.model, anchor.lineNumber)
            if (point) {
              item.owner.preserve(point)
            }
          }
          update()
          invalidate()
        }
      })
    )
    for (const pane of [diff.getOriginalEditor(), diff.getModifiedEditor()]) {
      this.subscriptions.push(
        pane.onDidContentSizeChange(invalidate),
        pane.onDidChangeViewZones(invalidate),
        pane.onDidChangeHiddenAreas(invalidate),
        pane.onDidChangeConfiguration(invalidate),
        pane.onDidScrollChange(() => {
          if (!this.detached && !this.applying) {
            item.owner.invalidateView()
          }
        }),
        pane.onDidRequestSemanticReveal((request) => this.reveal(pane, request)),
        pane.setVerticalSelectionDragDelegate(({ model, deltaY }) => {
          if (!this.detached && pane.getModel() === model) {
            item.owner.input(deltaY)
          }
        }),
        pane.onDidChangeFindWidgetGeometry(() => {
          if (!this.detached) {
            item.owner.invalidateView()
          }
        }),
        pane.setFindWidgetGeometryDelegate({
          getPosition: ({ domNode }) => {
            const paneRect = pane.getContainerDomNode().getBoundingClientRect()
            const hostRect = item.owner.root.getBoundingClientRect()
            const top = Math.max(
              hostRect.top + this.anchors.chromeHeight(),
              Math.min(paneRect.top, hostRect.bottom - domNode.offsetHeight)
            )
            return {
              top: top - paneRect.top,
              left: Math.max(0, paneRect.width - domNode.offsetWidth)
            }
          }
        })
      )
      this.cleanups.push(
        registerCombinedEditorGeometry(pane, {
          item,
          identity: this.identity,
          onUnbind: this.onUnbind,
          registerZone: (id, node, controls) =>
            this.anchors.zones.register(pane, id, node, controls),
          measureZone: (id, node, measure) =>
            this.anchors.zones.measureZone(pane, id, node, measure) ?? false,
          zonePoint: (id, node, controls) => this.anchors.zones.zonePoint(pane, id, node, controls)
        })
      )
    }
  }

  updateOptions(options: editor.IDiffEditorConstructionOptions): void {
    this.options = options
    this.item.owner.invalidate(this.item)
  }

  apply(item: DiffItemLayout, viewport: DiffViewportLayout, width: number): void {
    if (this.detached) {
      return
    }
    this.applying = true
    try {
      this.current = { item, viewport }
      const bodyHeight = Math.max(
        0,
        item.renderedHeight - this.anchors.chromeHeight() - this.borderHeight()
      )
      const nativeHeight = Math.max(0, bodyHeight - DIFF_SECTION_PADDING_HEIGHT)
      this.body.style.height = `${bodyHeight}px`
      this.body.style.transform = ''
      this.template.node.style.height = `${nativeHeight}px`
      this.template.node.style.width = `${width}px`
      if (this.originalOptions !== this.options || this.width !== width) {
        this.template.editor.updateOptions({ ...this.options, automaticLayout: false })
        this.record.viewModel.updateOptions(this.options, width)
        this.originalOptions = this.options
      }
      if (this.width !== width || this.nativeHeight !== nativeHeight) {
        this.width = width
        this.nativeHeight = nativeHeight
        this.template.editor.layout({ width, height: nativeHeight })
      }
      const original = this.template.editor.getOriginalEditor()
      if (original.getScrollTop() !== item.scrollOffset) {
        original.setScrollTop(item.scrollOffset, monaco.editor.ScrollType.Immediate)
      }
      this.template.editor.getOriginalEditor().layoutFindWidget()
      this.template.editor.getModifiedEditor().layoutFindWidget()
    } finally {
      this.applying = false
    }
  }

  readHeight(): number | null {
    return this.detached
      ? null
      : readCombinedDiffHeight(
          this.template.editor,
          this.record.viewModel,
          this.width,
          this.anchors.chromeHeight() + this.borderHeight()
        )
  }

  isScrollApplied(): boolean {
    const offset = this.current?.item.scrollOffset
    return (
      offset !== undefined &&
      this.readHeight() !== null &&
      isCombinedDiffScrollApplied(this.template.editor, this.record.model, offset)
    )
  }

  private borderHeight(): number {
    const row = this.item.chrome.header?.parentElement
    return row ? Math.max(0, row.offsetHeight - row.clientHeight) : 0
  }

  hasFocus(): boolean {
    const active = document.activeElement
    return (
      active !== null &&
      (this.item.node?.contains(active) === true || this.template.overflow.contains(active))
    )
  }

  capture(edge: number, previous?: DiffSemanticPoint): DiffSemanticPoint | null {
    return this.anchors.capture(edge, previous)
  }

  private reveal(pane: editor.ICodeEditor, request: editor.ISemanticViewRevealRequest): void {
    if (
      this.detached ||
      pane.getModel() !== request.model ||
      request.source === 'restoreState' ||
      request.source === 'modelChange'
    ) {
      return
    }
    let range: IRange | null = request.range
    for (const selection of request.selections ?? []) {
      const selectionRange = monaco.Selection.liftSelection(selection)
      range = range ? monaco.Range.plusRange(range, selectionRange) : selectionRange
    }
    if (!range) {
      return
    }
    const point = this.anchors.modelPoint(
      pane,
      request.model,
      range.startLineNumber,
      range.startColumn,
      range
    )
    if (!point) {
      return
    }
    point.fitScrollTop = (preferredTop) => {
      const top = point.project()
      const bottom = point.projectEnd?.() ?? null
      if (
        (request.selections?.length ?? 0) > 0 &&
        top !== null &&
        bottom !== null &&
        bottom - top > this.anchors.usableHeight(pane)
      ) {
        return this.item.owner.getScrollTop()
      }
      return this.anchors.fitRange(pane, top, bottom, preferredTop)
    }
    point.revealDisplacement = () => {
      const usable = this.anchors.usableInterval(pane)
      const top = point.project()
      const bottom = point.projectEnd?.() ?? null
      if (!usable || top === null || bottom === null) {
        return null
      }
      const sticky = pane.getOption(monaco.editor.EditorOption.stickyScroll)
      return diffRevealDisplacement({
        top,
        bottom,
        height: usable.bottom,
        chrome: usable.top,
        lineHeight: pane.getOption(monaco.editor.EditorOption.lineHeight),
        surroundingLines: Math.max(
          pane.getOption(monaco.editor.EditorOption.cursorSurroundingLines),
          sticky.enabled ? sticky.maxLineCount : 0
        ),
        surroundingLinesStyle: pane.getOption(
          monaco.editor.EditorOption.cursorSurroundingLinesStyle
        ),
        source: request.source,
        minimalReveal: request.minimalReveal,
        multipleSelections: (request.selections?.length ?? 0) > 0,
        verticalType: request.verticalType
      })
    }
    this.item.owner.reveal(this.item, () => point, undefined, point)
  }

  detach(): void {
    if (this.detached) {
      return
    }
    this.template.editor.stopHiddenRegionDrag()
    this.item.owner.releaseItemNavigation(this.item)
    this.record.viewState = this.template.editor.saveViewState()
    for (const dispose of this.onUnbind) {
      dispose()
    }
    this.onUnbind.clear()
    this.anchors.zones.clear()
    this.detached = true
    for (const pane of [
      this.template.editor.getOriginalEditor(),
      this.template.editor.getModifiedEditor()
    ]) {
      pane.stopSelectionDrag()
    }
    for (const dispose of this.cleanups) {
      dispose()
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose()
    }
    this.cleanups.length = 0
    this.subscriptions.length = 0
    this.current = null
    this.release()
  }
}
