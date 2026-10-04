import { afterEach, describe, expect, it } from 'vitest'

import { setRendererUiLanguage, translate } from './i18n'

afterEach(async () => {
  await setRendererUiLanguage('en')
})

describe('Turkish catalog after syncing the source locale', () => {
  it('loads new preview copy and restores English when switching back', async () => {
    const key = 'editor.markdownPreview.tooLarge'
    const fallback =
      'File is larger than the {{limit}} preview limit. Open the file to view its source.'

    await setRendererUiLanguage('tr')
    expect(translate(key, fallback, { limit: '10 MB' })).toBe(
      'Dosya, 10 MB önizleme sınırını aşıyor. Kaynağını görüntülemek için dosyayı açın.'
    )

    await setRendererUiLanguage('en')
    expect(translate(key, fallback, { limit: '10 MB' })).toBe(
      'File is larger than the 10 MB preview limit. Open the file to view its source.'
    )
  })

  it('retains command syntax and agent names in new failure guidance', async () => {
    await setRendererUiLanguage('tr')
    expect(
      translate('components.native-chat.failureWords.signInThenRunCommand', '', {
        command: 'compact'
      })
    ).toBe('Oturum açıp /compact komutunu yeniden çalıştırın.')
    expect(
      translate('components.native-chat.failureWords.couldNotStart', '', { agent: 'Codex' })
    ).toBe('Codex başlatılamadı.')
  })

  it('interpolates resumed-chat counts and credential source details', async () => {
    await setRendererUiLanguage('tr')
    expect(
      translate('auto.components.NativeChatResumeOnRestartModal.continuedMany', '', {
        value0: 3
      })
    ).toBe('3 sohbet geri yüklendi ve devam etmeleri istendi')
    expect(
      translate('auto.components.settings.CursorAccountsSection.signedInFrom', '', {
        source: 'macOS Anahtar Zinciri'
      })
    ).toBe('Oturum açıldı. Orca, macOS Anahtar Zinciri içinde saklanan oturumu okur.')
  })
})
