import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_THAI } from '../../../../shared/ui-language'
import { getLocalizedNativeChatSlashCommands } from './native-chat-slash-command-copy'

describe('native-chat-slash-command-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback description and an unchanged dispatch name', () => {
    const commands = getLocalizedNativeChatSlashCommands('codex')
    const model = commands.find((command) => command.name === 'model')
    expect(model?.name).toBe('model')
    expect(model?.description).toBe('Choose the model and reasoning effort')
  })

  it('keeps the same command name/description shape for unlisted agents', () => {
    const commands = getLocalizedNativeChatSlashCommands('gemini')
    const clear = commands.find((command) => command.name === 'clear')
    expect(clear?.description).toBe('Clear the conversation')
  })

  it('returns an empty catalog for grok, matching the underlying shared behavior', () => {
    expect(getLocalizedNativeChatSlashCommands('grok')).toEqual([])
  })

  it('namespaces descriptions per agent family so same-named commands do not collide', () => {
    const common = getLocalizedNativeChatSlashCommands('gemini').find((c) => c.name === 'clear')
    const claude = getLocalizedNativeChatSlashCommands('claude').find((c) => c.name === 'clear')
    const codex = getLocalizedNativeChatSlashCommands('codex').find((c) => c.name === 'clear')
    expect(common?.description).toBe('Clear the conversation')
    expect(claude?.description).toBe('Clear conversation history')
    expect(codex?.description).toBe('Clear the terminal and start a new chat')
  })

  it('does not throw when switching the UI language and still returns display text', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_THAI)
    expect(() => getLocalizedNativeChatSlashCommands('claude')).not.toThrow()
    const commands = getLocalizedNativeChatSlashCommands('claude')
    const help = commands.find((command) => command.name === 'help')
    expect(typeof help?.description).toBe('string')
    expect(help?.description).toBeTruthy()
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })
})
