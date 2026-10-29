import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { localizedCreateFailure } from './hosted-review-create-failure-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('localizedCreateFailure for missing create fields', () => {
  it('localizes the reason and keeps the English error for an older host', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const english = 'Create PR failed: base branch, head branch, and title are required.'
    expect(
      localizedCreateFailure(
        { ok: false, code: 'validation', error: english, reason: 'base_head_title_required' },
        'bitbucket'
      )
    ).toContain(es.sourceControl.createReviewFailure.baseHeadTitleRequired)
    expect(localizedCreateFailure({ ok: false, code: 'validation', error: english }, 'gitea')).toBe(
      english
    )
  })
})

describe('localizedCreateFailure for stacked pull requests', () => {
  it('localizes a stacked reason and falls back to English without its branch', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const english = 'Orca found multiple open pull requests for the current branch feature/x.'
    expect(
      localizedCreateFailure(
        {
          ok: false,
          code: 'validation',
          error: english,
          reason: 'stack_head_ambiguous',
          head: 'feature/x'
        },
        'github'
      )
    ).toBe(
      es.sourceControl.createReviewFailure.stacked.stackHeadAmbiguous.replace(
        '{{head}}',
        'feature/x'
      )
    )
    expect(
      localizedCreateFailure(
        { ok: false, code: 'validation', error: english, reason: 'stack_head_ambiguous' },
        'github'
      )
    ).toBe(english)
  })
})
