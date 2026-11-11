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
    const invalidate = (): void => item.owner.invalidate()
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
        pane.onDidScrollChange(invalidate),
        pane.onDidRequestSemanticReveal((request) => this.reveal(pane, request)),
        pane.setVerticalSelectionDragDelegate(({ model, deltaY }) => {
          if (!this.detached && pane.getModel() === model) {
            item.owner.input(deltaY)
          }
        }),
        pane.onDidChangeFindWidgetGeometry(invalidate),
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
    this.item.owner.invalidate()
  }

  apply(item: DiffItemLayout, viewport: DiffViewportLayout, width: number): void {
    if (this.detached) {
      return
    }
    this.current = { item, viewport }
    const bodyHeight = Math.max(0, item.renderedHeight - this.anchors.chromeHeight())
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
      original.setScrollTop(item.scrollOffset, monaco.ScrollType.Immediate)
    }
    this.template.editor.getOriginalEditor().layoutFindWidget()
    this.template.editor.getModifiedEditor().layoutFindWidget()
  }

  readHeight(): number | null {
    const state = this.record.viewModel.getDiffState()
    if (this.detached || !state.isDiffUpToDate || !state.hasResult || this.width <= 0) {
      return null
    }
    return (
      this.anchors.chromeHeight() +
      DIFF_SECTION_PADDING_HEIGHT +
      Math.max(
        this.template.editor.getOriginalEditor().getContentHeight(),
        this.template.editor.getModifiedEditor().getContentHeight()
      )
    )
  }

  hasFocus(): boolean {
    const active = document.activeElement
    return (
      active !== null &&
      (this.item.node?.contains(active) === true || this.template.overflow.contains(active))
    )
  }

  capture(edge: number): DiffSemanticPoint | null {
    return this.anchors.capture(edge)
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
      range = range ? monaco.Range.plusRange(range, selection) : selection
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
    point.revealDisplacement = (height) => {
      const top = point.project()
      const bottom = point.projectEnd?.() ?? null
      if (top === null || bottom === null) {
        return null
      }
      const sticky = pane.getOption(monaco.editor.EditorOption.stickyScroll)
      return diffRevealDisplacement({
        top,
        bottom,
        height,
        chrome: this.anchors.chromeHeight(),
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
    this.record.viewState = this.template.editor.saveViewState()
    for (const dispose of this.onUnbind) {
      dispose()
    }
    this.onUnbind.clear()
    this.anchors.zones.clear()
    this.detached = true
    this.item.owner.cancelItemNavigation(this.item)
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
