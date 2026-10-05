import { createInstance, type ResourceKey } from 'i18next'
import { describe, expect, it } from 'vitest'

import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

type LocaleCatalog = ResourceKey

const KEY = 'auto.components.terminal.pane.terminal.drop.handler.uploadingFilesToRemote'

/** Renders the upload toast key from one locale catalog through a fresh i18next instance. */
async function render(locale: string, catalog: LocaleCatalog, count: number): Promise<string> {
  const instance = createInstance()
  await instance.init({ lng: locale, resources: { [locale]: { translation: catalog } } })
  return instance.t(KEY, { count })
}

describe('remote upload toast plural', () => {
  it('pluralizes the English file noun by count', async () => {
    expect(await render('en', en, 1)).toBe('Uploading 1 file to remote…')
    expect(await render('en', en, 3)).toBe('Uploading 3 files to remote…')
  })

  it.each([
    ['es', es, 'archivos'],
    ['fr', fr, 'fichiers']
  ])('%s uses its own plural noun', async (locale, catalog, plural) => {
    expect(await render(locale, catalog, 3)).toContain(`3 ${plural}`)
  })

  // The English "s" suffix must never leak into languages without a plural noun form.
  it.each([
    ['ja', ja, 'ファイル'],
    ['ko', ko, '파일'],
    ['zh', zh, '文件']
  ])('%s renders the file noun without an English suffix', async (locale, catalog, noun) => {
    const message = await render(locale, catalog, 3)
    expect(message).toContain(noun)
    expect(message).not.toContain(`${noun}s`)
    expect(message).not.toContain('{{')
  })
})
