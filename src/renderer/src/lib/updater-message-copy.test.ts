import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { updaterCodedMessage } from '../../../shared/updater-failure-copy'
import { updaterMessageText } from './updater-message-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('updater message copy', () => {
  it('translates coded updater messages and keeps channel names verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(updaterMessageText(updaterCodedMessage('updateServerUnreachable'))).toBe(
      es.updates.failure.updateServerUnreachable
    )
    expect(
      updaterMessageText(updaterCodedMessage('unsignedDevChannel', { channel: 'Hourly' }))
    ).toBe(es.updates.failure.unsignedDevChannel.replace('{{channel}}', 'Hourly'))
  })

  it('keeps the English message for older hosts, unknown codes and missing params', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(updaterMessageText({ message: 'Older host text' })).toBe('Older host text')
    expect(updaterMessageText({ message: 'Newer host text', messageCode: 'futureCode' })).toBe(
      'Newer host text'
    )
    expect(
      updaterMessageText({
        message: 'Hourly builds are unsigned…',
        messageCode: 'unsignedDevChannel'
      })
    ).toBe('Hourly builds are unsigned…')
  })
})
