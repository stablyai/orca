import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import es from '@/i18n/locales/es.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import zh from '@/i18n/locales/zh.json'

// Why assert the catalog rather than the component: en.json is bundled as the `en`
// resource, so a catalog value wins over translate()'s code fallback. Editing a fallback
// alone renders nothing, and nothing else in CI compares the two.
describe('OSC 52 setting copy', () => {
  const locales = { en, es, ja, ko, zh }

  for (const [name, locale] of Object.entries(locales)) {
    it(`names Zellij and Grok in both ${name} OSC 52 setting descriptions`, () => {
      const pane = locale.auto.components.settings.TerminalPane
      for (const copy of [pane['69c64a479c'], pane['6e6480a7df']]) {
        expect(copy).toContain('Zellij')
        expect(copy).toContain('Grok')
      }
    })
  }

  // The notice is a one-shot the user sees exactly once, so a stale catalog value would
  // ship unnoticed. Pin en.json to the code fallbacks verbatim.
  it('keeps the migration notice catalog identical to its code fallbacks', () => {
    const notice = en.auto.components.terminal.pane.osc52.clipboard.default.on.notice
    expect(notice.title).toBe('TUI clipboard writes are now on by default')
    expect(notice.description).toBe(
      'Zellij, tmux, Neovim and other terminal programs can now copy to your clipboard. Turn it off in Terminal settings.'
    )
    expect(notice.action).toBe('Open Setting')
  })

  for (const [name, locale] of Object.entries({ es, ja, ko, zh })) {
    it(`translates the ${name} migration notice rather than leaving English placeholders`, () => {
      const notice = locale.auto.components.terminal.pane.osc52.clipboard.default.on.notice
      const english = en.auto.components.terminal.pane.osc52.clipboard.default.on.notice
      expect(notice.title).not.toBe(english.title)
      expect(notice.description).not.toBe(english.description)
      // Product names must survive translation — they are how the user recognizes the change.
      expect(notice.description).toContain('Zellij')
    })
  }
})
