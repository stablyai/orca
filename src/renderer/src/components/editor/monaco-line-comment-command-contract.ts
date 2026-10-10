declare module 'monaco-editor/esm/vs/editor/contrib/comment/browser/lineCommentCommand.js' {
  import type { editor, Selection } from 'monaco-editor'

  export class LineCommentCommand implements editor.ICommand {
    constructor(
      configuration: {
        getLanguageConfiguration(languageId: string): {
          comments: { blockCommentStartToken: string; blockCommentEndToken: string }
        }
      },
      selection: Selection,
      indentSize: number,
      type: 0,
      insertSpace: boolean,
      ignoreEmptyLines: boolean,
      ignoreFirstLine: boolean
    )
    getEditOperations(model: editor.ITextModel, builder: editor.IEditOperationBuilder): void
    computeCursorState(model: editor.ITextModel, helper: editor.ICursorStateComputerData): Selection
  }
}

declare module 'monaco-editor/esm/vs/editor/common/cursor/cursor.js' {
  import type { editor, Selection } from 'monaco-editor'

  export class CommandExecutor {
    static executeCommands(
      model: editor.ITextModel,
      selections: Selection[],
      commands: editor.ICommand[]
    ): Selection[] | null
  }
}
