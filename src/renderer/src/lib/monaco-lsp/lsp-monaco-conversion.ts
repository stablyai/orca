/** Pure LSP↔Monaco shape converters. LSP is 0-based, Monaco 1-based; both use
 *  UTF-16 columns, so only the off-by-one shift is needed. Monaco enum objects
 *  are passed in by the caller so this module stays import-free and node-testable. */

import type { IRange } from 'monaco-editor'

export const LSP_MARKER_OWNER = 'orca-lsp'

export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }

type LspMarkupContent = { kind?: string; value: string }
type LspMarkedString = string | { language: string; value: string }
type LspLocation = { uri: string; range: LspRange }
type LspLocationLink = { targetUri: string; targetRange: LspRange; targetSelectionRange?: LspRange }

export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function lspRangeToMonaco(range: LspRange): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

function markedStringToMarkdown(content: LspMarkedString | LspMarkupContent): string {
  if (typeof content === 'string') {
    return content
  }
  if ('language' in content && content.language) {
    return `\`\`\`${content.language}\n${content.value}\n\`\`\``
  }
  return content.value
}

export function lspHoverToMonaco(
  result: unknown
): { contents: { value: string }[]; range?: IRange } | null {
  const hover = result as {
    contents?: LspMarkedString | LspMarkupContent | (LspMarkedString | LspMarkupContent)[]
    range?: LspRange
  } | null
  if (!hover?.contents) {
    return null
  }
  const parts = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  const contents = parts
    .map(markedStringToMarkdown)
    .filter((value) => value.trim().length > 0)
    .map((value) => ({ value }))
  if (contents.length === 0) {
    return null
  }
  return hover.range ? { contents, range: lspRangeToMonaco(hover.range) } : { contents }
}

export function lspDefinitionToLocations(result: unknown): { uri: string; range: IRange }[] {
  if (!result) {
    return []
  }
  const items = Array.isArray(result) ? result : [result]
  return items.flatMap((item) => {
    const link = item as Partial<LspLocationLink> & Partial<LspLocation>
    if (link.targetUri && link.targetRange) {
      return [
        {
          uri: link.targetUri,
          range: lspRangeToMonaco(link.targetSelectionRange ?? link.targetRange)
        }
      ]
    }
    if (link.uri && link.range) {
      return [{ uri: link.uri, range: lspRangeToMonaco(link.range) }]
    }
    return []
  })
}

// LSP CompletionItemKind codes (1-based) by Monaco kind name.
const LSP_COMPLETION_KIND_NAMES: readonly string[] = [
  'Text',
  'Method',
  'Function',
  'Constructor',
  'Field',
  'Variable',
  'Class',
  'Interface',
  'Module',
  'Property',
  'Unit',
  'Value',
  'Enum',
  'Keyword',
  'Snippet',
  'Color',
  'File',
  'Reference',
  'Folder',
  'EnumMember',
  'Constant',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter'
]

type LspCompletionItem = {
  label: string
  kind?: number
  detail?: string
  documentation?: string | LspMarkupContent
  sortText?: string
  filterText?: string
  insertText?: string
  insertTextFormat?: number
  textEdit?: { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange }
}

export type MonacoSuggestionShape = {
  label: string
  kind: number
  detail?: string
  documentation?: { value: string }
  sortText?: string
  filterText?: string
  insertText: string
  insertTextRules?: number
  range: IRange
}

export function lspCompletionToMonaco(
  result: unknown,
  defaultRange: IRange,
  enums: { kinds: Record<string, number>; snippetRule: number }
): { suggestions: MonacoSuggestionShape[]; incomplete: boolean } {
  const list = result as
    | { items?: LspCompletionItem[]; isIncomplete?: boolean }
    | LspCompletionItem[]
    | null
  const items = Array.isArray(list) ? list : (list?.items ?? [])
  const incomplete = !Array.isArray(list) && list?.isIncomplete === true
  const suggestions = items.map((item): MonacoSuggestionShape => {
    const editRange = item.textEdit?.range ?? item.textEdit?.insert
    const kindName = LSP_COMPLETION_KIND_NAMES[(item.kind ?? 1) - 1] ?? 'Text'
    const suggestion: MonacoSuggestionShape = {
      label: item.label,
      kind: enums.kinds[kindName] ?? enums.kinds.Text,
      insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
      range: editRange ? lspRangeToMonaco(editRange) : defaultRange
    }
    if (item.detail) {
      suggestion.detail = item.detail
    }
    if (item.documentation) {
      suggestion.documentation = { value: markedStringToMarkdown(item.documentation) }
    }
    if (item.sortText) {
      suggestion.sortText = item.sortText
    }
    if (item.filterText) {
      suggestion.filterText = item.filterText
    }
    if (item.insertTextFormat === 2) {
      suggestion.insertTextRules = enums.snippetRule
    }
    return suggestion
  })
  return { suggestions, incomplete }
}

type LspDiagnostic = {
  range: LspRange
  message: string
  severity?: number
  code?: string | number | { value: string | number }
  source?: string
}

export type MonacoMarkerShape = IRange & {
  severity: number
  message: string
  code?: string
  source?: string
}

export function lspDiagnosticsToMonacoMarkers(
  diagnostics: unknown[],
  severities: { Error: number; Warning: number; Info: number; Hint: number }
): MonacoMarkerShape[] {
  const severityByLspCode = [severities.Error, severities.Warning, severities.Info, severities.Hint]
  return (diagnostics as LspDiagnostic[])
    .filter((diagnostic) => diagnostic?.range && typeof diagnostic.message === 'string')
    .map((diagnostic) => {
      const code =
        typeof diagnostic.code === 'object' && diagnostic.code !== null
          ? diagnostic.code.value
          : diagnostic.code
      const marker: MonacoMarkerShape = {
        ...lspRangeToMonaco(diagnostic.range),
        severity: severityByLspCode[(diagnostic.severity ?? 1) - 1] ?? severities.Error,
        message: diagnostic.message
      }
      if (code !== undefined) {
        marker.code = String(code)
      }
      if (diagnostic.source) {
        marker.source = diagnostic.source
      }
      return marker
    })
}

/** Pull-diagnostics response (textDocument/diagnostic) → diagnostic items.
 *  Null means "keep the current markers" (kind: 'unchanged' or malformed). */
export function lspPullDiagnosticsToItems(result: unknown): unknown[] | null {
  const report = result as { kind?: string; items?: unknown[] } | null
  if (report?.kind === 'full' && Array.isArray(report.items)) {
    return report.items
  }
  return null
}

/** file:// URI → local absolute path (posix or Windows). Null for anything else. */
export function fileUriToPath(uri: string): string | null {
  const match = /^file:\/\/(?<host>[^/]*)(?<path>\/.*)$/i.exec(uri)
  if (!match?.groups) {
    return null
  }
  const host = match.groups.host
  if (host && host !== 'localhost') {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(match.groups.path)
  } catch {
    return null
  }
  const driveMatch = /^\/([A-Za-z]:)(\/.*)?$/.exec(decoded)
  if (driveMatch) {
    return `${driveMatch[1]}${(driveMatch[2] ?? '/').replace(/\//g, '\\')}`
  }
  return decoded
}
