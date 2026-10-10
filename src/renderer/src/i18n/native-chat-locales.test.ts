import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../shared/agent-session-option-catalog-claude-codex'

const localizedCatalogs = { es, ja, ko, zh }
const englishSetting = en.auto.components.settings.ExperimentalPane.nativeChat
const englishSearch = en.auto.components.settings.experimental.search.nativeChat
const englishComposer = en.components['native-chat'].composer
const localizedEffortValues = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

const codexEffortValues = new Set(
  [
    ...CODEX_SESSION_OPTION_CATALOG.models.flatMap((model) => model.options),
    ...(CODEX_SESSION_OPTION_CATALOG.unknownModelOptions ?? [])
  ].flatMap((option) =>
    option.id === 'effort' && option.kind.type === 'select'
      ? option.kind.choices.map((choice) => choice.value)
      : []
  )
)

describe('native chat locale copy', () => {
  it.each(Object.entries({ en, es, fr, ja, ko, zh }))(
    '%s covers chat naming controls and ordinary labels',
    (_code, catalog) => {
      const names = catalog.settings.chat.names
      expect(Object.keys(names).sort()).toEqual(Object.keys(en.settings.chat.names).sort())
      for (const value of Object.values(names)) {
        expect(value.trim()).not.toBe('')
      }
      expect(names.description).toContain('Claude Chat')
      expect(names.description).toContain('Codex Chat')
      expect(catalog.auto.components.settings.Settings['17bdee4ff1']).not.toContain('Git')
      expect(catalog.auto.components.settings.Settings['43b68e10f0']).not.toContain('Git')
    }
  )

  it('covers every Codex effort choice', () => {
    expect([...codexEffortValues].sort()).toEqual([...localizedEffortValues].sort())
  })

  it.each(Object.entries(localizedCatalogs))(
    '%s falls back to current Chat UI copy until it is translated',
    (_code, catalog) => {
      const setting = catalog.auto.components.settings.ExperimentalPane.nativeChat
      const search = catalog.auto.components.settings.experimental.search.nativeChat
      expect(englishSetting.description).toContain('Chat UI')
      expect(englishSetting.copy).toContain('structured chat')
      expect(englishSearch.description).toContain('Chat UI')
      expect(setting).not.toHaveProperty('description')
      expect(setting).not.toHaveProperty('copy')
      expect(setting).not.toHaveProperty('defaultCopy')
      expect(search).not.toHaveProperty('description')
      expect(search.grok).toBe('grok')
      const composer = catalog.components['native-chat'].composer
      for (const key of [
        'model',
        'effort',
        'fastMode',
        'thinking',
        'options',
        'sessionOptions',
        'chooseInAgentPicker',
        'toggleOption',
        'sentNotConfirmed'
      ] as const) {
        expect(composer[key].trim()).not.toBe('')
        expect(composer[key]).not.toBe(englishComposer[key])
      }
      for (const key of ['fast', ...localizedEffortValues] as const) {
        expect(composer.optionValue[key].trim()).not.toBe('')
        expect(composer.optionValue[key]).not.toBe(englishComposer.optionValue[key])
      }
    }
  )
})

describe('account-aware Send fixes', () => {
  it.each(Object.entries({ en, es, fr, ja, ko, zh }))(
    '%s includes the same fixes for Send and post-send failures',
    (_locale, catalog) => {
      const words = catalog.components['native-chat'].failureWords
      expect(words.claudeSystemNotSignedIn).toContain('`{{loginCommand}}`')
      expect(words.codexSystemNotSignedIn).toContain('`{{loginCommand}}`')
      expect(words.claudeManagedNotSignedIn).not.toContain('/login')
      expect(words.codexManagedNotSignedIn).not.toContain('`codex login`')
      expect(words.claudeManagedNotSignedIn).not.toContain('{{loginCommand}}')
      expect(words.codexManagedNotSignedIn).not.toContain('{{loginCommand}}')
      expect(words.agentCommandNotSignedIn).toContain('{{agent}}')
      expect(words.agentCommandNotSignedIn).toContain('`{{loginCommand}}`')
      expect(words.interactiveAgentNotSignedIn).toContain('`{{slashCommand}}`')
      expect(words.cliMissing).toContain('{{agent}}')
      for (const key of ['claudeManagedNotSignedIn', 'codexManagedNotSignedIn'] as const) {
        expect(words[key].trim()).not.toBe('')
      }
    }
  )
})
