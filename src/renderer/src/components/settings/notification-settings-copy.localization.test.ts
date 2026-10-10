import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import { getSystemNotificationSettingsCopy } from './notification-settings-copy'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('getSystemNotificationSettingsCopy localization', () => {
  it('keeps the English copy in English', () => {
    expect(getSystemNotificationSettingsCopy('darwin')).toEqual({
      failureTitle: 'macOS did not show the notification',
      failureDescription: 'Enable Allow notifications for Orca in System Settings.'
    })
  })

  it('follows the selected UI language', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(getSystemNotificationSettingsCopy('win32')).toEqual({
      failureTitle: 'Windows no mostró la notificación',
      failureDescription: 'Activa las notificaciones para Orca en Configuración de Windows.'
    })
    expect(getSystemNotificationSettingsCopy('linux')).toBeNull()
  })
})
