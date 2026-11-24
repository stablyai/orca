import { translate } from '@/i18n/i18n'
import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import {
  dedupeCodeLocations,
  executeLspPrepareRename,
  isSelfDeclarationTarget,
  type CodeChooserState,
  type CodeNavActionParams,
  type CodeOutlineState,
  type CodeRenameRequest,
  type CodeStatusHint
} from './code-intelligence-actions'
import type {
  CodeGotoKind,
  CodeNavigationResult,
  CodeOutlineResult
} from './code-intelligence-types'
import type { CodeNavigationHistory } from './code-navigation-history'

type StoreCallbacks = {
  history: CodeNavigationHistory
  jumpToLocation: (
    target: { filePath: string; line: number; column?: number },
    origin?: { filePath: string; line: number; column: number }
  ) => void
  showStatusHint: (hint: CodeStatusHint) => void
  setChooser: (chooser: CodeChooserState | null) => void
  setOutline: (outline: CodeOutlineState | null) => void
  setRenameRequest: (req: CodeRenameRequest | null) => void
}

export async function runCodeGotoFlow(
  params: CodeNavActionParams & { kind: CodeGotoKind },
  cb: StoreCallbacks
): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  try {
    const result = await invokeNative<CodeNavigationResult>('poc_lsp_definition', {
      filePath: params.filePath,
      workspaceRoot: params.workspaceRoot,
      language: params.language,
      line: params.line,
      column: params.column,
      kind: params.kind,
      text: params.text
    })
    const locations = dedupeCodeLocations(result.locations)
    if (locations.length === 0) {
      const label = params.word || 'symbol'
      const msg =
        params.kind === 'implementation'
          ? `No implementations found for '${label}'`
          : params.kind === 'typeDefinition'
            ? `No type definition found for '${label}'`
            : `No declaration found for '${label}'`
      cb.showStatusHint({ text: msg, tone: 'warning', language: params.language })
      return
    }
    if (
      params.kind === 'definition' &&
      locations.length === 1 &&
      isSelfDeclarationTarget(locations[0], params.filePath, params.line, params.column)
    ) {
      await runFindReferencesFlow(params, cb)
      return
    }
    if (locations.length === 1) {
      cb.jumpToLocation(locations[0], {
        filePath: params.filePath,
        line: params.line,
        column: params.column
      })
      return
    }
    const kindTitle =
      params.kind === 'implementation'
        ? translate('auto.store.codeIntelligence.implementationsTitle', 'Implementations')
        : params.kind === 'typeDefinition'
          ? translate('auto.store.codeIntelligence.typeDefinitionsTitle', 'Type Definitions')
          : translate('auto.store.codeIntelligence.declarationsTitle', 'Declarations')
    cb.history.update(
      { filePath: params.filePath, line: params.line, column: params.column },
      false
    )
    cb.setChooser({
      title: translate(
        'auto.store.codeIntelligence.chooserTitle',
        '{{kind}} of {{symbol}} ({{count}})',
        {
          kind: kindTitle,
          symbol: params.word || 'symbol',
          count: locations.length
        }
      ),
      symbol: params.word,
      items: locations,
      source: result.source,
      anchor: params.anchor
    })
  } catch (err) {
    cb.showStatusHint({
      text: err instanceof Error ? err.message : String(err),
      tone: 'warning'
    })
  }
}

export async function runFindReferencesFlow(
  params: CodeNavActionParams,
  cb: StoreCallbacks
): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  try {
    const result = await invokeNative<CodeNavigationResult>('poc_lsp_references', {
      filePath: params.filePath,
      workspaceRoot: params.workspaceRoot,
      language: params.language,
      line: params.line,
      column: params.column,
      includeDeclaration: true,
      text: params.text
    })
    const items = dedupeCodeLocations(result.locations)
    if (items.length === 0) {
      cb.showStatusHint({
        text: `No usages found for '${params.word || 'symbol'}'`,
        tone: 'info'
      })
      return
    }
    cb.history.update(
      { filePath: params.filePath, line: params.line, column: params.column },
      false
    )
    cb.setChooser({
      title: translate(
        'auto.store.codeIntelligence.usagesTitle',
        'Usages of {{symbol}} ({{count}})',
        {
          symbol: params.word || 'symbol',
          count: items.length
        }
      ),
      symbol: params.word,
      items,
      source: result.source,
      anchor: params.anchor
    })
  } catch (err) {
    cb.showStatusHint({
      text: err instanceof Error ? err.message : String(err),
      tone: 'warning'
    })
  }
}

export async function runOpenOutlineFlow(
  params: { filePath: string; workspaceRoot: string | null; language: string; text: string },
  cb: StoreCallbacks
): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  try {
    const result = await invokeNative<CodeOutlineResult>('poc_lsp_document_symbols', {
      filePath: params.filePath,
      workspaceRoot: params.workspaceRoot,
      language: params.language,
      text: params.text
    })
    cb.setOutline({
      filePath: params.filePath,
      language: params.language,
      symbols: result.symbols,
      source: result.source
    })
  } catch (err) {
    cb.showStatusHint({
      text: err instanceof Error ? err.message : String(err),
      tone: 'warning'
    })
  }
}

export async function runBeginRenameFlow(
  params: CodeNavActionParams,
  cb: StoreCallbacks
): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  try {
    const prep = await executeLspPrepareRename(params)
    if (!prep || !prep.canRename) {
      cb.showStatusHint({ text: 'Cannot rename symbol at cursor', tone: 'warning' })
      return
    }
    cb.setRenameRequest({
      filePath: params.filePath,
      workspaceRoot: params.workspaceRoot,
      language: params.language,
      text: params.text,
      line: prep.line,
      column: prep.column,
      currentName: prep.placeholder || params.word,
      lspAvailable: prep.lspAvailable,
      anchor: params.anchor
    })
  } catch (err) {
    cb.showStatusHint({
      text: err instanceof Error ? err.message : String(err),
      tone: 'warning'
    })
  }
}
