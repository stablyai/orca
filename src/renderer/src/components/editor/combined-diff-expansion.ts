import type { editor } from 'monaco-editor'
import type { CombinedDiffExtent } from './combined-diff-extent'
import { getMeasuredDiffSectionBodyHeight } from './diff-section-layout'

export function createCombinedDiffExpansion(
  owner: CombinedDiffExtent,
  geometry: {
    index: () => number
    body: HTMLElement
    row: HTMLElement
    panes: readonly editor.ICodeEditor[]
    point: (pane: editor.ICodeEditor, line: number) => number
    prepare: (target: number) => void
    publish: (height: number) => void
    acknowledge: (update: () => void) => void
  }
) {
  let operation:
    | {
        pane: editor.ICodeEditor
        request: editor.IEditorScrollAnchorRequest
        scope: NonNullable<ReturnType<CombinedDiffExtent['beginEdit']>>
      }
    | undefined
  let updating = false
  const cancel = (): void => {
    operation?.scope.dispose()
    operation = undefined
  }
  const valid = (): boolean =>
    !!operation && operation.scope.active() && operation.pane.getModel() === operation.request.model
  const reconcile = (): boolean => {
    const current = operation
    if (!current || !valid()) {
      cancel()
      return false
    }
    if (updating) {
      return true
    }
    const { pane, request, scope } = current
    updating = true
    try {
      const preparedContent = Math.max(...geometry.panes.map((pane) => pane.getContentHeight()))
      geometry.prepare(scope.target(geometry.point(pane, request.lineNumber)))
      const content = Math.max(...geometry.panes.map((pane) => pane.getContentHeight()))
      geometry.publish(content)
      if (!valid() || operation !== current) {
        cancel()
        return true
      }
      // A native flush alone does not acknowledge React's current row measurement.
      if (
        preparedContent !== content ||
        content !== Math.max(...geometry.panes.map((pane) => pane.getContentHeight())) ||
        Math.round(geometry.body.getBoundingClientRect().height) !==
          Math.round(getMeasuredDiffSectionBodyHeight(content)) ||
        owner.item(geometry.index())?.size !==
          Math.round(geometry.row.getBoundingClientRect().height)
      ) {
        return true
      }
      operation = undefined
      scope.commit(geometry.point(pane, request.lineNumber))
      return true
    } catch (error) {
      cancel()
      throw error
    } finally {
      updating = false
    }
  }
  return {
    cancel,
    reconcile,
    run: (pane: editor.ICodeEditor, request: editor.IEditorScrollAnchorRequest): boolean => {
      if (pane.getModel() !== request.model) {
        return false
      }
      if (
        !valid() ||
        operation?.pane !== pane ||
        operation.request.lineNumber !== request.lineNumber
      ) {
        cancel()
        const scope = owner.beginEdit(geometry.index(), geometry.point(pane, request.lineNumber))
        if (!scope) {
          return false
        }
        operation = { pane, request, scope }
      }
      updating = true
      try {
        geometry.acknowledge(request.update)
      } catch (error) {
        cancel()
        throw error
      } finally {
        updating = false
      }
      reconcile()
      return true
    }
  }
}
