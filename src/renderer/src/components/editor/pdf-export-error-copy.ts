import { translate } from '@/i18n/i18n'
import {
  PDF_EXPORT_FAILURE_COPY as EN,
  type PdfExportFailureCode
} from '../../../../shared/pdf-export-failure-copy'

const COPY: Record<PdfExportFailureCode, () => string> = {
  noContent: () => translate('editor.pdfExport.errors.noContent', EN.noContent),
  timedOut: () => translate('editor.pdfExport.errors.timedOut', EN.timedOut),
  failed: () => translate('auto.components.editor.export.active.markdown.eda2cea3ad', EN.failed)
}

function isPdfExportFailureCode(code: unknown): code is PdfExportFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** Known codes translate; uncoded errors (Chromium/fs text) stay verbatim. */
export function pdfExportErrorText(result: { error?: string; errorCode?: unknown }): string {
  if (isPdfExportFailureCode(result.errorCode)) {
    return COPY[result.errorCode]()
  }
  return result.error ?? COPY.failed()
}
