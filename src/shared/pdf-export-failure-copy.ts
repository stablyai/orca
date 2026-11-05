// One English table for Markdown PDF export failures: main builds the English `error`, the renderer translates by code.
export const PDF_EXPORT_FAILURE_COPY = {
  noContent: 'No content to export',
  timedOut: 'Export timed out',
  failed: 'Failed to export PDF'
} as const

export type PdfExportFailureCode = keyof typeof PDF_EXPORT_FAILURE_COPY

export type PdfExportResult =
  | { success: true; filePath: string }
  | { success: false; cancelled?: boolean; error?: string; errorCode?: string }

export function pdfExportFailure(errorCode: PdfExportFailureCode): {
  success: false
  error: string
  errorCode: PdfExportFailureCode
} {
  return { success: false, error: PDF_EXPORT_FAILURE_COPY[errorCode], errorCode }
}
