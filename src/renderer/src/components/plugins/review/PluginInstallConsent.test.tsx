// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setRendererPluginLanguagePacks } from '@/i18n/i18n'
import { pluginLanguageResourceId } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { PluginInstallConsent } from './PluginInstallConsent'

const packId = 'plugin:community/czech/cs' as const

function renderEditorConsent(): string {
  const view = render(
    <PluginInstallConsent
      trust={{
        worker: false,
        declarative: false,
        panel: true,
        editor: true,
        sidebarPanel: false,
        recipesOnly: false
      }}
      capabilities={[]}
      shortcuts={[]}
      editorFileTypes={['.a', '.b']}
      installed={null}
      official={false}
      publisher="community"
      changed={false}
      error={null}
    />
  )
  return view.container.textContent ?? ''
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  setRendererPluginLanguagePacks([])
  i18n.removeResourceBundle('de', 'translation')
})

describe('PluginInstallConsent editor file types', () => {
  it('joins them in English when a language pack leaves the protected sentence English', async () => {
    const resourceLanguage = pluginLanguageResourceId(packId)
    setRendererPluginLanguagePacks([
      {
        id: packId,
        resourceLanguage,
        pluginKey: 'community/czech',
        locale: 'cs',
        catalog: { auto: { components: { sidebar: { title: 'Projekty' } } } },
        coverage: 1
      }
    ])
    await i18n.changeLanguage(resourceLanguage)
    expect(renderEditorConsent()).toContain('Opens and edits .a and .b files in Orca.')
  })

  it('joins them in the UI language when the sentence is translated', async () => {
    i18n.addResourceBundle('de', 'translation', {
      auto: {
        components: {
          settings: {
            PluginInstallConsent: { editsFileTypes: 'Öffnet und bearbeitet {{value0}}-Dateien.' }
          }
        }
      }
    })
    await i18n.changeLanguage('de')
    expect(renderEditorConsent()).toContain('Öffnet und bearbeitet .a und .b-Dateien.')
  })
})
