import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { repoCreateFailure } from '../../../../shared/repo-create-failure-copy'
import { repoCreateErrorText } from './repo-create-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('repoCreateErrorText', () => {
  it('localizes a coded failure and keeps the name and fs detail verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const notEmpty = repoCreateFailure('targetNotEmpty', { name: 'demo' })
    expect(notEmpty.error).toBe('"demo" already exists at this location and is not empty.')
    expect(repoCreateFailure('targetNotFolder', { name: 'a{{detail}}' }).error).toBe(
      '"a{{detail}}" already exists at this location and is not a folder.'
    )
    expect(repoCreateErrorText(notEmpty)).toBe(
      es.sidebar.createProject.errors.targetNotEmpty.replace('{{name}}', 'demo')
    )
    const failed = repoCreateFailure('prepareDirectoryFailed', { detail: 'EACCES: denied' })
    expect(repoCreateErrorText(failed)).toBe(
      es.sidebar.createProject.errors.prepareDirectoryFailed.replace('{{detail}}', 'EACCES: denied')
    )
  })

  it('shows the host English for uncoded, unknown, or incomplete failures', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(repoCreateErrorText({ error: 'Old host text' })).toBe('Old host text')
    expect(repoCreateErrorText({ error: 'Newer host text', errorCode: 'futureCode' })).toBe(
      'Newer host text'
    )
    expect(repoCreateErrorText({ error: 'English', errorCode: 'targetNotEmpty' })).toBe('English')
    expect(repoCreateErrorText({ error: 'English', errorCode: 'toString' })).toBe('English')
  })
})
