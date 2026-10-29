import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { bitbucketConnectFailure } from '../../../shared/bitbucket-credentials'
import { bitbucketConnectErrorText } from './bitbucket-connect-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('bitbucket connect error copy', () => {
  it('translates a coded failure while its wire error stays English', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const failure = bitbucketConnectFailure('rejected')
    expect(failure.error).toBe(
      'Bitbucket rejected these credentials. Check the email and token, then try again.'
    )
    expect(bitbucketConnectErrorText(failure)).toBe(es.codeHost.bitbucketConnect.rejected)
  })

  it('shows the English error for uncoded or unknown failures', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(bitbucketConnectErrorText({ error: 'Enter an access token.' })).toBe(
      'Enter an access token.'
    )
    expect(bitbucketConnectErrorText({ error: 'New text', errorCode: 'fromNewerHost' })).toBe(
      'New text'
    )
  })
})
