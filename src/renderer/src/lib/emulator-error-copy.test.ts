import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { emulatorCodedMessage, emulatorFailureText } from '../../../shared/emulator-failure-copy'
import { emulatorErrorText, emulatorMessageText } from './emulator-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('emulator error copy', () => {
  it('translates a thrown error by its operational code and keeps device names verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const message = emulatorFailureText('androidDeviceNotRunning', { device: 'Pixel 7 "Pro"' })
    expect(emulatorErrorText(rpcError('emulator_device_not_found', message), 'fallback')).toBe(
      es.emulator.errors.androidDeviceNotRunning.replace('{{device}}', 'Pixel 7 "Pro"')
    )
    expect(emulatorErrorText(rpcError('emulator_disabled', message), 'fallback')).toBe(message)
    expect(emulatorErrorText(rpcError('emulator_error', 'adb: device offline'), 'x')).toBe(
      'adb: device offline'
    )
    expect(emulatorErrorText('not an error', 'fallback')).toBe('fallback')
  })

  it('translates coded availability text and keeps uncoded or unknown text in English', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(emulatorMessageText(emulatorCodedMessage('noAndroidDevices'))).toBe(
      es.emulator.errors.noAndroidDevices
    )
    expect(emulatorMessageText({ message: 'Newer host text', messageCode: 'futureCode' })).toBe(
      'Newer host text'
    )
    expect(
      emulatorMessageText({ message: 'Simulator x not found.', messageCode: 'simulatorNotFound' })
    ).toBe('Simulator x not found.')
  })
})
