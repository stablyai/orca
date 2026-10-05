import { describe, expect, it } from 'vitest'
import {
  MarkdownDocumentListingCapacityError,
  MARKDOWN_DOCUMENT_LISTING_ERROR_CODE,
  MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE
} from '../../../../shared/markdown-document-listing-limits'
import {
  extractIpcErrorMessage,
  isMarkdownDocumentCapacityError
} from './rich-markdown-ipc-error-message'

describe('Markdown document capacity errors', () => {
  it.each([
    new MarkdownDocumentListingCapacityError(),
    new Error(
      `Error invoking remote method 'fs:listMarkdownDocuments': MarkdownDocumentListingCapacityError: ${MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE}`
    ),
    new Error(
      `Error invoking remote method 'fs:listMarkdownDocuments': Error: ${MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE}`
    ),
    Object.assign(new Error('Translated capacity message'), {
      code: MARKDOWN_DOCUMENT_LISTING_ERROR_CODE
    }),
    Object.assign(new Error(MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE), { code: 'runtime_error' }),
    { response: { error: { code: MARKDOWN_DOCUMENT_LISTING_ERROR_CODE, message: 'Translated' } } },
    new Error(`Error invoking remote method 'rpc': Error: ${MARKDOWN_DOCUMENT_LISTING_ERROR_CODE}`)
  ])('recognizes the local, Electron and paired capacity shapes: %s', (error) => {
    expect(isMarkdownDocumentCapacityError(error)).toBe(true)
  })

  it.each([
    new Error('Permission denied'),
    new Error('Disconnected from the execution host'),
    new Error(`Other failure: ${MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE}`),
    Object.assign(new Error(MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE), {
      code: 'permission_denied'
    }),
    Object.assign(new Error(MARKDOWN_DOCUMENT_LISTING_ERROR_CODE), { code: 'permission_denied' }),
    null,
    MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE
  ])('does not classify unrelated or conflicting failures: %s', (error) => {
    expect(isMarkdownDocumentCapacityError(error)).toBe(false)
  })

  it('extracts standard and named IPC errors while preserving ordinary messages', () => {
    expect(
      extractIpcErrorMessage(
        new Error("Error invoking remote method 'save': TypeError: Cannot save."),
        'Fallback'
      )
    ).toBe('Cannot save.')
    expect(extractIpcErrorMessage(new Error('Cannot save.'), 'Fallback')).toBe('Cannot save.')
    expect(extractIpcErrorMessage(null, 'Fallback')).toBe('Fallback')
  })
})
