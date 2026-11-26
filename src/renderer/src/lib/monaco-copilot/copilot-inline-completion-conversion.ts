import type { IRange } from 'monaco-editor'
import { lspRangeToMonaco } from './lsp-monaco-position-conversion'
import type { LspPosition, LspRange } from './lsp-monaco-position-conversion'

export type CopilotInlineItem = { insertText: string; range: IRange | undefined }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isLspPosition(value: unknown): value is LspPosition {
  return isRecord(value) && typeof value.line === 'number' && typeof value.character === 'number'
}

function isLspRange(value: unknown): value is LspRange {
  return isRecord(value) && isLspPosition(value.start) && isLspPosition(value.end)
}

// Why: LSP 3.18 allows a StringValue ({ kind: 'snippet', value }) as well as a plain string.
function readInsertText(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw
  }
  return isRecord(raw) && typeof raw.value === 'string' ? raw.value : null
}

/** textDocument/inlineCompletion result → Monaco inline items. Newlines are
 *  normalized to the model's EOL, as the Copilot LS README requires. */
export function copilotInlineCompletionsToMonaco(
  result: unknown,
  eol: string
): CopilotInlineItem[] {
  const rawItems = Array.isArray(result) ? result : isRecord(result) ? (result.items ?? []) : []
  if (!Array.isArray(rawItems)) {
    return []
  }
  const items: CopilotInlineItem[] = []
  for (const raw of rawItems) {
    const item = isRecord(raw) ? raw : null
    const insertText = readInsertText(item?.insertText)
    if (!insertText) {
      continue
    }
    items.push({
      insertText: insertText.replace(/\r\n|\r|\n/g, eol),
      range: isLspRange(item?.range) ? lspRangeToMonaco(item.range) : undefined
    })
  }
  return items
}
