import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { textGenerationFailure } from '../../../shared/text-generation-failure-copy'
import { localizeTextGenerationResult, textGenerationErrorText } from './text-generation-error-copy'

const originalLanguage = i18n.language
const errors = es.sourceControl.textGeneration.errors

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('textGenerationErrorText', () => {
  it('localizes a coded failure and keeps the agent label and CLI output verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const failed = textGenerationFailure('cliFailedWithDetail', {
      label: 'Codex',
      exitCode: 2,
      detail: 'unauthorized {{label}}'
    })
    expect(failed.error).toBe('Codex CLI command failed with code 2: unauthorized {{label}}')
    expect(textGenerationErrorText(failed)).toBe(
      errors.cliFailedWithDetail
        .replace('{{label}}', 'Codex')
        .replace('{{exitCode}}', '2')
        .replace('{{detail}}', 'unauthorized {{label}}')
    )
    expect(
      localizeTextGenerationResult({ success: false, ...textGenerationFailure('noStagedChanges') })
    ).toEqual({ success: false, error: errors.noStagedChanges, errorCode: 'noStagedChanges' })
  })

  it('shows the host English for uncoded, unknown, or incomplete failures', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(textGenerationErrorText({ error: 'Old host text' })).toBe('Old host text')
    expect(textGenerationErrorText({ error: 'Newer host', errorCode: 'futureCode' })).toBe(
      'Newer host'
    )
    expect(textGenerationErrorText({ error: 'English', errorCode: 'cliFailedWithDetail' })).toBe(
      'English'
    )
    expect(textGenerationErrorText({ error: 'English', errorCode: 'toString' })).toBe('English')
  })
})
