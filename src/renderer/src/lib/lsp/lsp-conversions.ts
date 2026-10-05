// src/renderer/src/lib/lsp/lsp-conversions.ts
export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }
export type LspLocation = { uri: string; range: LspRange }
export type MonacoRangeLike = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && typeof value.line === 'number' && typeof value.character === 'number'
}

export function isLspRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end)
}

export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  // Why: both sides count UTF-16 code units, so only the base differs.
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function toMonacoRange(range: LspRange): MonacoRangeLike {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

function toLocation(value: unknown): LspLocation | null {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.uri === 'string' && isLspRange(value.range)) {
    return { uri: value.uri, range: value.range }
  }
  const target = isLspRange(value.targetSelectionRange)
    ? value.targetSelectionRange
    : value.targetRange
  if (typeof value.targetUri === 'string' && isLspRange(target)) {
    return { uri: value.targetUri, range: target }
  }
  return null
}

export function toLspLocations(result: unknown): LspLocation[] {
  const items = Array.isArray(result) ? result : [result]
  return items.map(toLocation).filter((location): location is LspLocation => location !== null)
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&')
}

function toMarkdown(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!isRecord(content) || typeof content.value !== 'string') {
    return null
  }
  if (typeof content.language === 'string') {
    return `\`\`\`${content.language}\n${content.value}\n\`\`\``
  }
  return content.kind === 'plaintext' ? escapeMarkdown(content.value) : content.value
}

export function toHoverContents(contents: unknown): { value: string }[] {
  const items = Array.isArray(contents) ? contents : [contents]
  return items
    .map(toMarkdown)
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value }))
}
