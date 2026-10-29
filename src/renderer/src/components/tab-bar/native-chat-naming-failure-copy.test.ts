import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { nativeChatNamingErrorText } from './native-chat-naming-failure-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('nativeChatNamingErrorText', () => {
  it('localizes coded failures and keeps agent or unknown-code messages verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(
      nativeChatNamingErrorText({
        message: 'English',
        failedAt: 1,
        messageCode: 'noName'
      })
    ).toBe(es.tabHoverCard.namingFailure.errors.noName)
    for (const messageCode of ['grokFailed', 'antigravityFailed'] as const) {
      expect(
        nativeChatNamingErrorText({
          message: 'private provider diagnostic',
          failedAt: 1,
          messageCode
        })
      ).toBe(es.tabHoverCard.namingFailure.errors[messageCode])
    }
    expect(nativeChatNamingErrorText({ message: 'claude exited 1', failedAt: 1 })).toBe(
      'claude exited 1'
    )
    expect(
      nativeChatNamingErrorText({
        message: 'Newer host',
        failedAt: 1,
        messageCode: 'future'
      })
    ).toBe('Newer host')
  })
})
