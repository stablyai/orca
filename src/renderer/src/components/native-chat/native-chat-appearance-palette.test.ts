// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import * as terminalThemeSelection from '../../../../shared/terminal-themes/terminal-theme-selection'
import { TERMINAL_COLOR_OVERRIDES_SETTING } from '../../../../shared/terminal-themes/terminal-color-overrides'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

const css = readFileSync(resolve('src/renderer/src/assets/main.css'), 'utf8')
// Happy DOM only needs the ordinary rules; Tailwind directives are compiled separately below.
const paletteCss = [
  ...css.matchAll(/(?:^|\n)(:root[^{}]*|\.dark[^{}]*|\.native-chat-appearance[^{}]*)\{([^{}]*)\}/g)
]
  .map((match) => match[0])
  .join('\n')

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.documentElement.className = ''
  vi.restoreAllMocks()
})

function createChat(appScheme: 'light' | 'dark', terminalScheme: 'light' | 'dark'): HTMLElement {
  document.documentElement.classList.toggle('dark', appScheme === 'dark')
  const sheet = document.createElement('style')
  sheet.textContent = paletteCss
  document.head.append(sheet)
  const chat = document.createElement('div')
  chat.className = 'native-chat-appearance'
  const style = nativeChatAppearanceStyle(
    createGlobalSettingsFixture({
      theme: appScheme,
      [TERMINAL_COLOR_OVERRIDES_SETTING[appScheme]]:
        terminalScheme === 'light'
          ? { background: '#ffffff', foreground: '#000000' }
          : { background: '#000000', foreground: '#ffffff' },
      nativeChatAppearance: { matchTerminalInterface: true }
    })
  )
  chat.dataset.nativeChatScheme = style.colorScheme
  chat.style.color = style.color ?? ''
  for (const [key, value] of Object.entries(style)) {
    if (key.startsWith('--')) {
      chat.style.setProperty(key, String(value))
    }
  }
  document.body.append(chat)
  return chat
}

describe('matching chat surfaces with opposite app schemes', () => {
  it('resolves an incomplete terminal palette without a local background variable cycle', () => {
    vi.spyOn(terminalThemeSelection, 'resolveConfiguredTerminalColors').mockReturnValue({})
    const chat = createChat('dark', 'light')
    expect(chat.dataset.nativeChatScheme).toBe('dark')
    const styles = getComputedStyle(chat)
    expect(styles.getPropertyValue('--chat-canvas')).toContain('#000000')
    expect(styles.getPropertyValue('--chat-source-foreground')).toBe('#fafafa')
  })
})
