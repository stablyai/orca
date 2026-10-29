import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { remoteServerPairingFailureMessage } from './remote-server-pairing-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('remote server pairing error copy', () => {
  it('translates a coded failure and keeps the server name verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const text = remoteServerPairingFailureMessage({
      message: 'A server named "Studio" already exists.',
      errorCode: 'nameTaken',
      errorParams: { name: 'Studio' }
    })
    expect(text).toBe(es.runtime.remoteServerPairingErrors.nameTaken.replace('{{name}}', 'Studio'))
    expect(text).not.toBe('A server named "Studio" already exists.')
  })

  it('shows the English message for uncoded, unknown, or incomplete failures', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const message = 'A server named "Studio" already exists.'
    expect(remoteServerPairingFailureMessage({ message })).toBe(message)
    expect(remoteServerPairingFailureMessage({ message, errorCode: 'fromNewerHost' })).toBe(message)
    expect(remoteServerPairingFailureMessage({ message, errorCode: 'nameTaken' })).toBe(message)
  })
})
