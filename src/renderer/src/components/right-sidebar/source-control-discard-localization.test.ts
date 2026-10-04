import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n/i18n'
import { getDiscardEntryConfirmationCopy } from './source-control/commit/discard-confirmation'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('discard descriptions with real locale catalogs', () => {
  it.each(['en', 'es', 'fr', 'ja', 'ko', 'zh'] as const)(
    'uses current index-preserving descriptions in %s',
    async (locale) => {
      await i18n.changeLanguage(locale)
      expect(
        getDiscardEntryConfirmationCopy({
          area: 'unstaged',
          path: 'changed.txt',
          status: 'modified'
        }).description
      ).toBe('This will revert the unstaged changes to this file. This cannot be undone.')
      expect(
        getDiscardEntryConfirmationCopy({
          area: 'unstaged',
          path: 'removed.txt',
          status: 'deleted'
        }).description
      ).toBe(
        'This will restore the last staged version and discard the deletion. This cannot be undone.'
      )
    }
  )
})
