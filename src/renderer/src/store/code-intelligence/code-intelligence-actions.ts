import { useAppStore } from '@/store/index'
import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import { normalizeDebugPathKey } from '../debug/debug-session-paths'
import type {
  CodeDiagnostic,
  CodeGotoKind,
  CodeLocation,
  CodeNavigationResult,
  CodeOutlineResult,
  CodePrepareRename,
  CodeWorkspaceEdit,
  LspRuntimeStatusEvent,
  LspServerStatus
} from './code-intelligence-types'
import { applyWorkspaceEditInOrca, replaceWholeWordInString } from './code-workspace-edit'

export type CodeChooserState = {
  title: string
  symbol: string
  items: CodeLocation[]
  source: 'lsp' | 'fallback'
  anchor: { x: number; y: number }
}

export type CodeOutlineState = {
  filePath: string
  language: string
  symbols: CodeOutlineResult['symbols']
  source: 'lsp' | 'fallback'
}

export type CodeRenameRequest = {
  filePath: string
  workspaceRoot: string | null
  language: string
  text: string
  line: number
  column: number
  currentName: string
  lspAvailable: boolean
  anchor: { x: number; y: number }
}

export type CodeStatusHint = {
  text: string
  tone: 'info' | 'warning'
  language?: string
}

export type CodeContextMenuRequest = {
  filePath: string
  workspaceRoot: string | null
  language: string
  text: string
  line: number
  column: number
  word: string
  readOnly: boolean
  hasSelection: boolean
  x: number
  y: number
}

export type CodeNavActionParams = {
  filePath: string
  workspaceRoot: string | null
  language: string
  text: string
  line: number
  column: number
  word: string
  anchor: { x: number; y: number }
}

export type CodeIntelligenceState = {
  diagnosticsByFile: Record<string, CodeDiagnostic[]>
  runtimeStatusByServer: Record<string, LspRuntimeStatusEvent>
  serverStatuses: LspServerStatus[]
  installingServerId: string | null
  canGoBack: boolean
  canGoForward: boolean
  chooser: CodeChooserState | null
  outline: CodeOutlineState | null
  renameRequest: CodeRenameRequest | null
  contextMenu: CodeContextMenuRequest | null
  statusHint: CodeStatusHint | null

  recordCursorPlace: (filePath: string, line: number, column: number) => void
  jumpToLocation: (
    target: { filePath: string; line: number; column?: number },
    origin?: { filePath: string; line: number; column: number }
  ) => void
  navigateBack: () => boolean
  navigateForward: () => boolean
  closeChooser: () => void
  closeOutline: () => void
  closeRename: () => void
  openContextMenu: (req: CodeContextMenuRequest) => void
  closeContextMenu: () => void
  showStatusHint: (hint: CodeStatusHint) => void
  dismissStatusHint: () => void
  runGoto: (params: CodeNavActionParams & { kind: CodeGotoKind }) => Promise<void>
  runFindReferences: (params: CodeNavActionParams) => Promise<void>
  openOutline: (params: {
    filePath: string
    workspaceRoot: string | null
    language: string
    text: string
  }) => Promise<void>
  beginRename: (params: CodeNavActionParams) => Promise<void>
  commitRename: (newName: string) => Promise<void>
  refreshServerStatuses: (workspaceRoot?: string | null) => Promise<void>
  installServer: (serverId: string, workspaceRoot?: string | null) => Promise<void>
}

export function dedupeCodeLocations(locations: readonly CodeLocation[]): CodeLocation[] {
  const seen = new Set<string>()
  const out: CodeLocation[] = []
  for (const loc of locations) {
    const key = `${normalizeDebugPathKey(loc.filePath)}:${loc.line}:${loc.column}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(loc)
    }
  }
  return out
}

export function isSelfDeclarationTarget(
  target: CodeLocation,
  filePath: string,
  line: number,
  column: number
): boolean {
  if (normalizeDebugPathKey(target.filePath) !== normalizeDebugPathKey(filePath)) {
    return false
  }
  return (
    line >= target.line &&
    line <= target.endLine &&
    column >= target.column &&
    column <= target.endColumn
  )
}

export async function executeLspGoto(
  params: CodeNavActionParams & { kind: CodeGotoKind }
): Promise<CodeLocation[] | null> {
  if (!isTauriNativeHost()) {
    return null
  }
  const result = await invokeNative<CodeNavigationResult>('poc_lsp_definition', {
    filePath: params.filePath,
    workspaceRoot: params.workspaceRoot,
    language: params.language,
    line: params.line,
    column: params.column,
    kind: params.kind,
    text: params.text
  })
  return dedupeCodeLocations(result.locations)
}

export async function executeLspPrepareRename(
  params: CodeNavActionParams
): Promise<CodePrepareRename | null> {
  if (!isTauriNativeHost()) {
    return null
  }
  return invokeNative<CodePrepareRename | null>('poc_lsp_prepare_rename', {
    filePath: params.filePath,
    workspaceRoot: params.workspaceRoot,
    language: params.language,
    line: params.line,
    column: params.column,
    text: params.text
  })
}

export async function executeCodeRenameCommit(
  req: CodeRenameRequest,
  trimmedName: string,
  readLiveBuffer: (key: string) => string | null
): Promise<string | null> {
  if (req.lspAvailable && isTauriNativeHost()) {
    try {
      const edit = await invokeNative<CodeWorkspaceEdit | null>('poc_lsp_rename', {
        filePath: req.filePath,
        workspaceRoot: req.workspaceRoot,
        language: req.language,
        line: req.line,
        column: req.column,
        newName: trimmedName,
        text: req.text
      })
      if (edit && edit.files.length > 0) {
        const stats = await applyWorkspaceEditInOrca(edit, readLiveBuffer)
        return `Renamed '${req.currentName}' -> '${trimmedName}' (${stats.editsApplied} edits across ${stats.filesUpdated} files)`
      }
    } catch {
      // Fall back to safe single-file identifier replacement when LSP rename fails.
    }
  }
  const key = normalizeDebugPathKey(req.filePath)
  const appState = useAppStore.getState()
  const openTab = appState.openFiles.find(
    (f) => f.mode === 'edit' && !f.readOnly && normalizeDebugPathKey(f.filePath) === key
  )
  if (!openTab) {
    return null
  }
  const currentText = readLiveBuffer(key) ?? appState.editorDrafts[openTab.id] ?? req.text
  const { text, count } = replaceWholeWordInString(currentText, req.currentName, trimmedName)
  if (count > 0 && text !== currentText) {
    appState.setEditorDraft(openTab.id, text)
    appState.markFileDirty(openTab.id, true)
    return `Renamed '${req.currentName}' -> '${trimmedName}' (${count} occurrences in file)`
  }
  return null
}
