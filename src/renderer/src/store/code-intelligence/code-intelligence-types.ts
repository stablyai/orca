export type CodeGotoKind = 'definition' | 'declaration' | 'typeDefinition' | 'implementation'

export type CodeLocation = {
  filePath: string
  line: number
  column: number
  endLine: number
  endColumn: number
  preview: string | null
  symbolName: string | null
}

export type CodeNavigationResult = {
  source: 'lsp' | 'fallback'
  serverId: string | null
  locations: CodeLocation[]
}

export type CodeHover = {
  markdown: string
  line: number | null
  column: number | null
  endLine: number | null
  endColumn: number | null
}

export type CodeCompletionItem = {
  label: string
  kind: string
  detail: string | null
  documentation: string | null
  insertText: string | null
  replaceFromLine: number | null
  replaceFromColumn: number | null
  replaceToLine: number | null
  replaceToColumn: number | null
}

export type CodeSignatureInfo = {
  label: string
  documentation: string | null
  parameters: string[]
}

export type CodeSignatureHelp = {
  signatures: CodeSignatureInfo[]
  activeSignature: number
  activeParameter: number
}

export type CodeDocumentSymbol = {
  name: string
  detail: string | null
  kind: string
  line: number
  column: number
  endLine: number
  endColumn: number
  selectionLine: number
  selectionColumn: number
  children: CodeDocumentSymbol[]
}

export type CodeOutlineResult = {
  source: 'lsp' | 'fallback'
  symbols: CodeDocumentSymbol[]
}

export type CodeDiagnostic = {
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source: string | null
  code: string | null
  deprecated: boolean
  unnecessary: boolean
}

export type CodePrepareRename = {
  canRename: boolean
  line: number
  column: number
  endLine: number
  endColumn: number
  placeholder: string
  lspAvailable: boolean
}

export type CodeTextEdit = {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  newText: string
}

export type CodeFileEdits = {
  filePath: string
  edits: CodeTextEdit[]
}

export type CodeWorkspaceEdit = {
  files: CodeFileEdits[]
}

export type LspServerStatus = {
  id: string
  displayName: string
  command: string
  languages: string[]
  status: 'running' | 'installed' | 'onPath' | 'missing'
  path: string | null
  canInstall: boolean
  installMethod: string
  installHint: string
  homepage: string
}

export type LspDiagnosticsEvent = {
  filePath: string
  fileKey: string
  diagnostics: CodeDiagnostic[]
}

export type LspRuntimeStatusEvent = {
  serverId: string
  rootPath: string
  status: 'starting' | 'ready' | 'error'
  message: string | null
}

export type NavigationLocation = {
  filePath: string
  line: number
  column: number
  time: number
}
