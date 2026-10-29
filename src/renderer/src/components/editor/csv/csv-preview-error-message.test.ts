import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { CsvPreviewError } from './csv-preview-error'
import { formatCsvPreviewError } from './csv-preview-error-message'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

it('translates CSV error codes and passes other errors through', async () => {
  await i18n.changeLanguage('es')
  expect(formatCsvPreviewError(new CsvPreviewError('binary-data'))).toBe(
    'Este archivo contiene datos binarios.'
  )
  expect(formatCsvPreviewError(new Error('EACCES: permission denied'))).toBe(
    'EACCES: permission denied'
  )
})
