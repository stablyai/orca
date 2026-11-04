import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { codeHostFailure } from '../../../shared/code-host-failure-copy'
import { reviewStartPointFailure } from '../../../shared/review-start-point-failure-copy'
import { codeHostErrorText, reviewStartPointErrorText } from './code-host-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('codeHostErrorText', () => {
  it('localizes a coded failure and keeps the gh/glab detail verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const unresolved = codeHostFailure('github.repoUnresolved')
    expect(unresolved.error).toBe('Could not resolve GitHub owner/repo for this repository')
    expect(codeHostErrorText(unresolved)).toBe(es.codeHost.errors.github.repoUnresolved)

    const detail = 'HTTP 422: {{detail}} $& rejected'
    const failed = codeHostFailure('github.rerunFailed', detail)
    expect(failed.error).toBe(`Failed to rerun checks: ${detail}`)
    expect(codeHostErrorText(failed)).toBe(
      es.codeHost.errors.github.rerunFailed.replace('{{detail}}', () => detail)
    )
  })

  it('localizes PR/MR start-point failures with their number, ref, and git detail', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const missing = reviewStartPointFailure('gitlab.mrNotFound', { number: 7 })
    expect(missing.error).toBe('MR !7 not found.')
    expect(reviewStartPointErrorText(missing)).toBe(
      es.codeHost.startPoint.gitlab.mrNotFound.replace('{{number}}', '7')
    )
    const fetch = reviewStartPointFailure('fetchFailed', {
      ref: 'origin/{{detail}}',
      detail: 'fatal: no route'
    })
    expect(fetch.error).toBe('Failed to fetch origin/{{detail}}: fatal: no route')
    expect(reviewStartPointErrorText(fetch)).toBe(
      es.codeHost.startPoint.fetchFailed.replace(/\{\{(ref|detail)\}\}/g, (_slot, slot) =>
        slot === 'ref' ? 'origin/{{detail}}' : 'fatal: no route'
      )
    )
    expect(reviewStartPointErrorText({ error: 'English', errorCode: 'gitlab.mrNotFound' })).toBe(
      'English'
    )
  })
})
