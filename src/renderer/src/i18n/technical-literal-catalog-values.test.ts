import { describe, expect, it } from 'vitest'

import en from './locales/en.json'
import es from './locales/es.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const repairedEntries = [
  ['es', 'auto.components.sidebar.AddRepoCreateStep.0ae45b8238'],
  ['es', 'auto.components.settings.RepositoryIconPicker.03ca1a4e9b'],
  ['es', 'auto.components.editor.MarkdownTemplatePicker.22cd94426f'],
  ['ko', 'auto.components.terminal.pane.stale.agent.row.090d607412'],
  ['ko', 'auto.components.settings.git.search.upstream'],
  ['ko', 'auto.components.feature.wall.FeatureWallSetupWorkflowActions.5c5b65044e'],
  ['ko', 'auto.components.editor.MarkdownTemplatePicker.22cd94426f'],
  ['zh', 'auto.components.sparse.SparseCheckoutPresetSelect.ddbcaef7be'],
  ['zh', 'auto.components.sidebar.AddRepoCreateStep.0ae45b8238'],
  ['zh', 'auto.components.settings.AutoRenameBranchFromWorkSetting.800edb1e54'],
  ['zh', 'auto.components.settings.BaseRefPicker.915ad97875'],
  ['zh', 'auto.components.settings.RepositoryHooksSection.39da2ae12f'],
  ['zh', 'auto.components.settings.SparsePresetSettingsSection.fde7ff2cc3'],
  ['zh', 'auto.components.settings.git.search.upstream'],
  ['zh', 'auto.components.settings.mobile.emulator.search.84e5706975'],
  ['zh', 'auto.components.settings.repository.search.603c68b68c'],
  ['zh', 'auto.components.feature.wall.BrowserAnimatedVisual.7da6eed7bf'],
  ['zh', 'auto.components.feature.wall.WorkbenchAnimatedVisual.defe550fe2'],
  ['zh', 'auto.components.feature.wall.WorkbenchAnimatedVisual.4371cc9931'],
  ['zh', 'auto.components.editor.IpynbViewer.8c3b21369a'],
  ['zh', 'auto.components.editor.MarkdownTemplatePicker.22cd94426f']
] as const

const catalogs = { es, ko, zh } as const

function readValue(catalog: object, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    return (value as Record<string, unknown>)[part]
  }, catalog)
}

describe('technical literal catalog repairs (#13121)', () => {
  it('keeps every repaired value identical to English', () => {
    expect(repairedEntries).toHaveLength(21)

    for (const [locale, key] of repairedEntries) {
      expect(readValue(catalogs[locale], key), `${locale}:${key}`).toBe(readValue(en, key))
    }
  })
})
