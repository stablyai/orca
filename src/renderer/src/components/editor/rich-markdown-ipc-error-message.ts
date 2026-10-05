import {
  MARKDOWN_DOCUMENT_LISTING_ERROR_CODE,
  MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE
} from '../../../../shared/markdown-document-listing-limits'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'

export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:\w*Error: )?(.+)/)
  return match ? match[1] : err.message
}

export function isMarkdownDocumentCapacityError(err: unknown): boolean {
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code !== 'runtime_error'
  ) {
    return err.code === MARKDOWN_DOCUMENT_LISTING_ERROR_CODE
  }
  return (
    hasRuntimeRpcErrorCode(err, MARKDOWN_DOCUMENT_LISTING_ERROR_CODE) ||
    extractIpcErrorMessage(err, '') === MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE
  )
}
