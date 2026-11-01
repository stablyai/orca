import type { editor } from 'monaco-editor'
import type { CombinedDiffExtent } from './combined-diff-extent'
import type {
  CombinedDiffCommentRequest,
  CombinedDiffCommentOperation
} from './combined-diff-navigation'
import { isCombinedDiffGeometryPublished } from './combined-diff-expansion'

export function createCombinedDiffCommentReveal(
  owner: CombinedDiffExtent,
  geometry: {
    index: () => number
    body: HTMLElement
    row: HTMLElement
    panes: readonly editor.ICodeEditor[]
    availableHeight: () => number
    resolve: (pane: editor.ICodeEditor, top: number, bottom: number) => number
    prepare: (target: number) => void
    publish: (height: number) => void
    commit: (target: number) => boolean
    schedule: () => void
  }
) {
  let operation:
    | {
        pane: editor.ICodeEditor
        model: editor.ITextModel | null
        request: CombinedDiffCommentRequest
        scope: NonNullable<ReturnType<CombinedDiffExtent['beginEdit']>>
      }
    | undefined
  let updating = false
  const cancel = (): void => {
    const current = operation
    operation = undefined
    current?.scope.dispose()
    current?.request.cancelled?.()
  }
  return {
    cancel,
    request: (
      pane: editor.ICodeEditor,
      request: CombinedDiffCommentRequest
    ): CombinedDiffCommentOperation => {
      cancel()
      const scope = owner.beginEdit(geometry.index(), pane.getScrollTop())
      const current = scope ? { pane, model: pane.getModel(), request, scope } : undefined
      operation = current
      geometry.schedule()
      return {
        update: () => {
          if (current && operation === current) {
            geometry.schedule()
          }
        },
        dispose: () => {
          if (current && operation === current) {
            cancel()
          }
        }
      }
    },
    reconcile: (): boolean => {
      const current = operation
      if (!current || !current.scope.active() || current.pane.getModel() !== current.model) {
        cancel()
        return false
      }
      if (updating) {
        return true
      }
      updating = true
      try {
        const read = () => current.request.read(geometry.availableHeight())
        const target = read()
        if (!target) {
          return true
        }
        const content = Math.max(...geometry.panes.map((pane) => pane.getContentHeight()))
        geometry.prepare(geometry.resolve(current.pane, target.top, target.bottom))
        geometry.publish(Math.max(...geometry.panes.map((pane) => pane.getContentHeight())))
        if (operation !== current || !current.scope.active()) {
          return true
        }
        const measured = read()
        if (!measured?.measured || !isCombinedDiffGeometryPublished(owner, geometry, content)) {
          return true
        }
        const next = geometry.resolve(current.pane, measured.top, measured.bottom)
        operation = undefined
        geometry.commit(next)
        current.request.complete()
        return true
      } catch (error) {
        cancel()
        throw error
      } finally {
        updating = false
      }
    }
  }
}
