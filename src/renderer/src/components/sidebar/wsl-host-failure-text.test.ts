import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import {
  wslHostAddRefusalText,
  wslHostServerStopReason,
  wslHostStatusDetailText
} from '../../../../shared/wsl-host-failure-copy'
import {
  wslHostAddRefusalMessage,
  wslHostStatusDetailMessage,
  wslHostStopReasonMessage
} from './wsl-host-failure-text'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

async function useSpanish(): Promise<void> {
  i18n.addResourceBundle('es', 'translation', es)
  await i18n.changeLanguage('es')
}

describe('WSL host failure text', () => {
  it('keeps the English wire text and translates it by code, commands verbatim', async () => {
    await useSpanish()
    const wsl1 = wslHostAddRefusalText('wsl1', { distro: 'Ubuntu' })
    expect(wsl1.text).toBe(
      'Ubuntu runs WSL 1, which Orca no longer supports. Convert it to WSL 2 in a Windows terminal with: wsl --set-version Ubuntu 2'
    )
    const translated = wslHostAddRefusalMessage({
      message: wsl1.text,
      errorCode: wsl1.code,
      errorParams: wsl1.params
    })
    expect(translated).toBe(
      es.sidebar.wslHosts.addErrors.wsl1
        .replace('{{distro}}', 'Ubuntu')
        .replace('{{command}}', 'wsl --set-version Ubuntu 2')
    )
    expect(translated).not.toBe(wsl1.text)
  })

  it('translates status details, including plural restarts and verbatim stop errors', async () => {
    await useSpanish()
    const gaveUp = wslHostStatusDetailText('restartGaveUp', { distro: 'Ubuntu', count: 5 })
    expect(gaveUp.text).toBe('Could not restart the Orca server in Ubuntu after 5 attempts')
    expect(
      wslHostStatusDetailMessage({
        detail: gaveUp.text,
        detailCode: gaveUp.code,
        detailParams: gaveUp.params
      })
    ).toBe(
      es.sidebar.wslHosts.statusDetails.restartGaveUp_other
        .replace('{{distro}}', 'Ubuntu')
        .replace('{{count}}', '5')
    )
    const unrecorded = wslHostServerStopReason('removalUnrecorded', { detail: 'EACCES' })
    expect(wslHostStopReasonMessage(unrecorded)).toBe(
      es.sidebar.wslHosts.statusDetails.removalUnrecorded.replace('{{detail}}', 'EACCES')
    )
  })

  it('shows the English text for uncoded, unknown, or incomplete codes', async () => {
    await useSpanish()
    expect(wslHostAddRefusalMessage({ message: 'bridge refused' })).toBe('bridge refused')
    expect(wslHostAddRefusalMessage({ message: 'Newer', errorCode: 'futureCode' })).toBe('Newer')
    expect(wslHostAddRefusalMessage({ message: 'English', errorCode: 'alreadyAdded' })).toBe(
      'English'
    )
    expect(wslHostAddRefusalMessage({ message: 'English', errorCode: 'toString' })).toBe('English')
    expect(
      wslHostStatusDetailMessage({
        detail: 'English',
        detailCode: 'restartGaveUp',
        detailParams: { distro: 'Ubuntu', count: '5' }
      })
    ).toBe('English')
  })
})
