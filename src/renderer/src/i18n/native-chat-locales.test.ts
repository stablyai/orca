import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../shared/agent-session-option-catalog-claude-codex'

const localizedCatalogs = { es, ja, ko, zh }
const englishSetting = en.auto.components.settings.ChatPane
const englishNav = en.auto.hooks.useSettingsNavigationMetadata
const englishResumeModal = en.auto.components.NativeChatResumeOnRestartModal
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
  it('covers every Codex effort choice', () => {
    expect([...codexEffortValues].sort()).toEqual([...localizedEffortValues].sort())
  })

  it.each(Object.entries(localizedCatalogs))(
    '%s keeps provider-neutral copy localized',
    (_code, catalog) => {
      const setting = catalog.auto.components.settings.ChatPane
      const search = catalog.auto.components.settings.chat.search
      const nav = catalog.auto.hooks.useSettingsNavigationMetadata
      const resumeModal = catalog.auto.components.NativeChatResumeOnRestartModal
      for (const [localized, english] of [
        [setting.description, englishSetting.description],
        [setting.copy, englishSetting.copy],
        [setting.defaultCopy, englishSetting.defaultCopy],
        [nav.chatDescription, englishNav.chatDescription],
        [resumeModal.dontAskAgainSettingsHint, englishResumeModal.dontAskAgainSettingsHint]
      ]) {
        expect(localized.trim()).not.toBe('')
        expect(localized).not.toBe(english)
      }
      // The pane is named after the product surface, which stays untranslated.
      expect(nav.chatTitle).toBe('Chat UI')
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
        'valueIsDefault',
        'valueNotReported',
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
