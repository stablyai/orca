export type EditorLanguagePosition = {
  lineNumber: number
  column: number
}

export type EditorLanguageRequest = {
  rootPath: string
  filePath: string
  content: string
  position: EditorLanguagePosition
}

export type EditorLanguageDefinitionResult = {
  filePath: string
  range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
}
