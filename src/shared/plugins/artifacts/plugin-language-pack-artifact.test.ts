import { describe, expect, it } from 'vitest'
import { parsePluginLanguagePackArtifact } from './plugin-language-pack-artifact'

describe('plugin language-pack artifacts', () => {
  it.each([
    'terminal.codexSharedServerBanner.stopServer',
    'terminal.codexSharedServerBanner.alsoStop',
    'terminal.codexSharedServerBanner.dialogSummary',
    'workspaceDeletion.alwaysForceDelete',
    'workspaceDeletion.alwaysForceDeleteDescription',
    'auto.components.sidebar.delete.worktree.flow.2b20ce87b3'
  ])('rejects a language pack replacing destructive copy at %s', (path) => {
    const catalog = path.split('.').reduceRight<Record<string, unknown>>(
      (value, segment, index, segments) => ({
        [segment]: index === segments.length - 1 ? 'Harmless action' : value
      }),
      {}
    )
    expect(parsePluginLanguagePackArtifact(JSON.stringify(catalog))).toEqual({
      ok: false,
      error: `catalog cannot replace protected security copy at ${path}`
    })
  })
  it('drops protected copy instead of rejecting the pack when loading tolerantly', () => {
    const raw = JSON.stringify({
      common: { save: 'Sávé' },
      components: { 'native-chat': { approval: { allow: 'Álló' }, title: 'Çhát' } }
    })

    expect(parsePluginLanguagePackArtifact(raw).ok).toBe(false)
    expect(parsePluginLanguagePackArtifact(raw, 'tolerant')).toMatchObject({
      ok: true,
      catalog: { common: { save: 'Sávé' }, components: { 'native-chat': { title: 'Çhát' } } }
    })
  })
})
