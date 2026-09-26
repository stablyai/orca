import type * as Monaco from 'monaco-editor'
import { createJsxCommentContextClassifier, type JsxCommentContext } from './jsx-comment-context'
import { buildJsxCommentEditPlan } from './jsx-comment-edit-plan'

export const ORCA_TOGGLE_JSX_COMMENT_ACTION_ID = 'orca.toggleJsxLineComment'

type InstallMonacoJsxCommentActionParams = {
  editorInstance: Monaco.editor.IStandaloneCodeEditor
  monaco: typeof Monaco
  filePath: string
}

export function getJsxCommentActionMode(
  contexts: readonly JsxCommentContext[]
): 'jsx' | 'mixed' | 'script' | 'unknown' {
  if (contexts.some((context) => context === 'unknown')) {
    return 'unknown'
  }
  if (contexts.every((context) => context === 'script')) {
    return 'script'
  }
  return contexts.every((context) => context === 'jsx') ? 'jsx' : 'mixed'
}

export function createSerialCommentAction(runAction: () => Promise<void>): () => Promise<void> {
  let actionTail: Promise<void> = Promise.resolve()
  return () => {
    const queuedAction = actionTail.then(runAction, runAction)
    actionTail = queuedAction.then(
      () => undefined,
      () => undefined
    )
    return queuedAction
  }
}

export function areSelectionsEqual(
  expected: readonly Monaco.ISelection[],
  actual: readonly Monaco.ISelection[] | null
): boolean {
  return (
    actual !== null &&
    expected.length === actual.length &&
    expected.every((selection, index) => {
      const current = actual[index]
      return (
        selection.selectionStartLineNumber === current.selectionStartLineNumber &&
        selection.selectionStartColumn === current.selectionStartColumn &&
        selection.positionLineNumber === current.positionLineNumber &&
        selection.positionColumn === current.positionColumn
      )
    })
  )
}

export function installMonacoJsxCommentAction({
  editorInstance,
  monaco,
  filePath
}: InstallMonacoJsxCommentActionParams): Monaco.IDisposable | null {
  const installedModel = editorInstance.getModel()
  if (!installedModel) {
    return null
  }
  const classifier = createJsxCommentContextClassifier(installedModel, filePath)
  if (!classifier) {
    return null
  }

  const defaultCommentAction = editorInstance.getAction('editor.action.commentLine')
  let disposed = false
  const runCommentAction = async (): Promise<void> => {
    if (disposed) {
      return
    }
    const model = editorInstance.getModel()
    const selections = editorInstance.getSelections()
    if (model !== installedModel || !selections || selections.length === 0) {
      await defaultCommentAction?.run()
      return
    }

    const versionId = model.getVersionId()
    const contexts = await classifier
      .getContexts(selections.map((selection) => selection.startLineNumber))
      .catch(() => null)
    if (disposed) {
      return
    }
    if (
      model.isDisposed() ||
      editorInstance.getModel() !== model ||
      model.getVersionId() !== versionId ||
      !areSelectionsEqual(selections, editorInstance.getSelections())
    ) {
      return
    }
    if (!contexts) {
      return
    }
    const actionMode = getJsxCommentActionMode(contexts)
    if (actionMode === 'script') {
      await defaultCommentAction?.run()
      return
    }
    if (actionMode !== 'jsx') {
      return
    }

    const commentOptions = editorInstance.getOption(monaco.editor.EditorOption.comments)
    const plan = buildJsxCommentEditPlan(model.getValue(), selections, {
      insertSpace: commentOptions.insertSpace
    })
    if (!plan || plan.edits.length === 0) {
      return
    }

    const edits = plan.edits.map((edit) => {
      const start = model.getPositionAt(edit.startOffset)
      const end = model.getPositionAt(edit.endOffset)
      return {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column
        },
        text: edit.text,
        forceMoveMarkers: edit.moveAtPosition
      }
    })
    const finalSelections = plan.selections.map(
      (selection) =>
        new monaco.Selection(
          selection.selectionStartLineNumber,
          selection.selectionStartColumn,
          selection.positionLineNumber,
          selection.positionColumn
        )
    )
    editorInstance.pushUndoStop()
    editorInstance.executeEdits(ORCA_TOGGLE_JSX_COMMENT_ACTION_ID, edits, finalSelections)
    editorInstance.pushUndoStop()
  }
  const enqueueCommentAction = createSerialCommentAction(runCommentAction)
  const action = editorInstance.addAction({
    id: ORCA_TOGGLE_JSX_COMMENT_ACTION_ID,
    label: defaultCommentAction?.label ?? 'Toggle Line Comment',
    precondition: '!editorReadonly',
    keybindingContext: 'editorTextFocus',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
    run: enqueueCommentAction
  })

  return {
    dispose: () => {
      disposed = true
      action.dispose()
      classifier.dispose()
    }
  }
}
