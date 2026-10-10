import { editor, KeyCode, KeyMod, Selection } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { getJsxCommentContexts } from './jsx-comment-context'
import { createJsxLineCommentCommands, getCommentEndLine } from './jsx-line-comment-commands'

export function installMonacoJsxCommentAction(
  instance: editor.IStandaloneCodeEditor,
  getRelativePath: () => string
): { dispose: () => void } {
  const nativeAction = instance.getAction('editor.action.commentLine')
  let disposed = false
  const toggle = async () => {
    const path = getRelativePath()
    if (disposed || instance.getOption(editor.EditorOption.readOnly)) {
      return
    }
    if (!/\.(jsx|tsx)$/i.test(path)) {
      await nativeAction?.run()
      return
    }
    const model = instance.getModel()
    const selections = instance.getSelections()
    if (!model || !selections?.length || !instance.hasTextFocus()) {
      return
    }
    const version = model.getVersionId()
    const isCurrent = () => {
      const current = instance.getSelections()
      return (
        !disposed &&
        instance.getModel() === model &&
        !model.isDisposed() &&
        model.getVersionId() === version &&
        getRelativePath() === path &&
        instance.hasTextFocus() &&
        !instance.getOption(editor.EditorOption.readOnly) &&
        current?.length === selections.length &&
        current.every((selection, index) => Selection.selectionsEqual(selection, selections[index]))
      )
    }
    const lines = selections.flatMap((selection) =>
      Array.from(
        { length: getCommentEndLine(selection) - selection.startLineNumber + 1 },
        (_, index) => selection.startLineNumber + index
      )
    )
    const contexts = await getJsxCommentContexts(model, lines, { isCurrent })
    if (!contexts || !isCurrent()) {
      return
    }
    if (contexts.every((context) => context === 'script')) {
      await nativeAction?.run()
      return
    }
    if (!contexts.every((context) => context === 'jsx')) {
      return
    }
    const commands = createJsxLineCommentCommands(
      model,
      selections,
      instance.getOption(editor.EditorOption.comments)
    )
    if (!commands) {
      return
    }
    instance.pushUndoStop()
    instance.executeCommands('orca.toggleJsxLineComment', commands)
    instance.pushUndoStop()
  }
  const action = instance.addAction({
    id: 'orca.toggleJsxLineComment',
    label: nativeAction?.label ?? 'Toggle Line Comment',
    precondition: '!editorReadonly',
    keybindingContext: 'editorTextFocus',
    keybindings: [KeyMod.CtrlCmd | KeyCode.Slash],
    run: () =>
      toggle().catch((error: unknown) => {
        console.error('Failed to toggle JSX line comment', error)
      })
  })
  return {
    dispose: () => {
      disposed = true
      action.dispose()
    }
  }
}
