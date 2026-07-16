import React, { useEffect, useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import { FileText, Sheet } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  decodeBase64Document,
  parseWorkbook,
  SPREADSHEET_PREVIEW_MAX_COLUMNS,
  SPREADSHEET_PREVIEW_MAX_ROWS,
  type SpreadsheetSheet
} from './office-document-parse'
import { getOfficeDocumentExtension } from './office-document-file'
import { OfficePresentationView } from './OfficePresentationView'

type ParsedDocument =
  | { kind: 'docx'; html: string; warnings: string[] }
  | { kind: 'pptx'; buffer: ArrayBuffer; contentBase64: string }
  | { kind: 'xlsx'; sheets: SpreadsheetSheet[] }

async function parseDocument(content: string, extension: string): Promise<ParsedDocument> {
  const buffer = decodeBase64Document(content)
  if (extension === 'docx') {
    const mammoth = await import('mammoth/mammoth.browser.js')
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer })
    return {
      kind: 'docx',
      html: DOMPurify.sanitize(result.value),
      warnings: result.messages.map((message) => message.message)
    }
  }
  if (extension === 'pptx') {
    return { kind: 'pptx', buffer, contentBase64: content }
  }
  return { kind: 'xlsx', sheets: await parseWorkbook(buffer) }
}

function SpreadsheetView({ sheets }: { sheets: SpreadsheetSheet[] }): React.JSX.Element {
  const [activeSheet, setActiveSheet] = useState(0)
  const sheet = sheets[activeSheet]
  const columnCount = sheet?.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0) ?? 0
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto scrollbar-editor">
        <table className="min-w-full border-collapse font-mono text-xs">
          <tbody>
            {(sheet?.rows ?? []).map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-accent/40">
                <th className="sticky left-0 border-b border-r border-border bg-muted px-2 py-1 text-right font-normal text-muted-foreground">
                  {rowIndex + 1}
                </th>
                {Array.from({ length: columnCount }, (_, columnIndex) => (
                  <td
                    key={columnIndex}
                    className="min-w-24 border-b border-r border-border px-2 py-1 text-foreground"
                  >
                    {row[columnIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet?.truncated ? (
        <div className="border-t border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          {translate(
            'auto.components.editor.OfficeDocumentViewer.spreadsheetPreviewLimited',
            'Preview limited to the first {{rows}} rows and {{columns}} columns.',
            {
              rows: SPREADSHEET_PREVIEW_MAX_ROWS,
              columns: SPREADSHEET_PREVIEW_MAX_COLUMNS
            }
          )}
        </div>
      ) : null}
      <div className="flex gap-1 overflow-x-auto border-t border-border bg-muted p-1">
        {sheets.map((candidate, index) => (
          <button
            type="button"
            key={candidate.name}
            className={`rounded-sm px-3 py-1 text-xs ${index === activeSheet ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-accent'}`}
            onClick={() => setActiveSheet(index)}
          >
            {candidate.name}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function OfficeDocumentViewer({
  content,
  filePath
}: {
  content: string
  filePath: string
}): React.JSX.Element {
  const extension = useMemo(() => getOfficeDocumentExtension(filePath) ?? '', [filePath])
  const [document, setDocument] = useState<ParsedDocument | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setDocument(null)
    setError(null)
    void parseDocument(content, extension).then(
      (parsed) => active && setDocument(parsed),
      (reason: unknown) =>
        active && setError(reason instanceof Error ? reason.message : String(reason))
    )
    return () => {
      active = false
    }
  }, [content, extension])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {error}
      </div>
    )
  }
  if (!document) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate('auto.components.editor.OfficeDocumentViewer.loading', 'Loading document...')}
      </div>
    )
  }
  if (document.kind === 'xlsx') {
    return <SpreadsheetView sheets={document.sheets} />
  }
  if (document.kind === 'pptx') {
    return (
      <OfficePresentationView buffer={document.buffer} contentBase64={document.contentBase64} />
    )
  }
  return (
    <div className="h-full overflow-auto bg-muted p-6 scrollbar-editor">
      <article className="office-document mx-auto min-h-full max-w-4xl rounded-md border border-border bg-background p-10 text-foreground shadow-xs">
        <div className="mb-6 flex items-center gap-2 border-b border-border pb-3 text-xs text-muted-foreground">
          <FileText className="size-4" />
          {filePath.split(/[\\/]/).pop()}
        </div>
        <div
          className="prose prose-sm max-w-none dark:prose-invert"
          dangerouslySetInnerHTML={{ __html: document.html }}
        />
        {document.warnings.length > 0 && (
          <div className="mt-8 border-t border-border pt-3 text-xs text-muted-foreground">
            <Sheet className="mr-2 inline size-3.5" />
            {translate(
              'auto.components.editor.OfficeDocumentViewer.formatWarning',
              'Some document formatting could not be reproduced.'
            )}
          </div>
        )}
      </article>
    </div>
  )
}
