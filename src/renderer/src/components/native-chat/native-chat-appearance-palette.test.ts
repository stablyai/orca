// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from 'tailwindcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import * as terminalThemeSelection from '../../../../shared/terminal-theme-selection'
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
      terminalColorOverrides:
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

const statusRoles = [
  '--destructive',
  '--status-success',
  '--status-warning',
  '--git-decoration-added',
  '--git-decoration-deleted',
  '--diff-added-ground',
  '--diff-added-gutter',
  '--diff-removed-ground',
  '--diff-removed-gutter'
]

describe('matching chat surfaces with opposite app schemes', () => {
  it.each([
    ['dark', 'light'],
    ['light', 'dark']
  ] as const)('uses the %s app with a %s terminal palette', (appScheme, terminalScheme) => {
    const chat = createChat(appScheme, terminalScheme)
    // These roles cover transcript payloads, question badges, inline completion menus and controls.
    const matched = getComputedStyle(chat)
    const terminalForegroundAtFullStrength = `${terminalScheme === 'light' ? '#000000' : '#ffffff'} 100%`
    expect(chat.style.color).toBe('var(--foreground)')
    expect(matched.getPropertyValue('--chat-foreground')).toContain(
      terminalForegroundAtFullStrength
    )
    expect(matched.getPropertyValue('--chat-foreground-strong')).toContain(
      terminalForegroundAtFullStrength
    )
    expect(matched.getPropertyValue('--foreground')).toContain(terminalForegroundAtFullStrength)
    expect(matched.getPropertyValue('--muted')).toContain('7%')
    expect(matched.getPropertyValue('--muted-foreground')).toContain('62%')
    expect(matched.getPropertyValue('--popover')).toContain('4%')
    expect(matched.getPropertyValue('--popover-foreground')).toContain(
      terminalForegroundAtFullStrength
    )
    expect(matched.getPropertyValue('--accent')).toContain('9%')
    expect(matched.getPropertyValue('--input')).toContain('7%')
    expect(matched.getPropertyValue('--secondary')).toContain('7%')
    expect(matched.getPropertyValue('--ring')).toContain('44%')
    expect(matched.getPropertyValue('--chat-source-background')).toBe(
      terminalScheme === 'light' ? '#ffffff' : '#000000'
    )
    expect(matched.getPropertyValue('--chat-source-foreground')).toBe(
      terminalScheme === 'light' ? '#000000' : '#ffffff'
    )
    const codeForeground = matched.getPropertyValue('--chat-code-foreground')
    expect(codeForeground).toContain(`${terminalScheme === 'light' ? '#000000' : '#ffffff'} 85%`)
    expect(codeForeground).toContain(terminalScheme === 'light' ? '#ffffff' : '#000000')
    expect(codeForeground).not.toContain(appScheme === 'dark' ? '#fafafa' : '#0a0a0a')
    const outside = getComputedStyle(document.documentElement)
    const appStatus = statusRoles.map((role) => outside.getPropertyValue(role))
    const chatStatus = statusRoles.map((role) => matched.getPropertyValue(role))
    expect(chatStatus.every(Boolean)).toBe(true)
    expect(chatStatus).not.toEqual(appStatus)
    document.documentElement.classList.toggle('dark', terminalScheme === 'dark')
    expect(
      statusRoles.map((role) => getComputedStyle(document.documentElement).getPropertyValue(role))
    ).toEqual(chatStatus)
  })

  it('resolves an incomplete terminal palette without a local background variable cycle', () => {
    vi.spyOn(terminalThemeSelection, 'resolveConfiguredTerminalColors').mockReturnValue({})
    const chat = createChat('dark', 'light')
    expect(chat.dataset.nativeChatScheme).toBe('dark')
    const styles = getComputedStyle(chat)
    expect(styles.getPropertyValue('--chat-canvas')).toContain('#000000')
    expect(styles.getPropertyValue('--chat-source-foreground')).toBe('#fafafa')
  })
})

describe('chat scheme and inherited dark utilities', () => {
  it('compiles the custom variant and excludes light chats and enables dark chats', async () => {
    const declaration = css.match(/^@custom-variant dark \((.+)\);$/m)
    expect(declaration).not.toBeNull()
    if (!declaration) {
      throw new Error('Missing dark variant')
    }
    const compiler = await compile(
      `${declaration[0]}\n@theme { --color-input: #123456; }\n@tailwind utilities;`
    )
    expect(compiler.build(['dark:bg-input/30'])).toContain('data-native-chat-scheme')
    expect(declaration[1]).toContain(
      ".dark *:not(:where([data-native-chat-scheme='light'], [data-native-chat-scheme='light'] *))"
    )
    expect(declaration[1]).toContain(
      ", [data-native-chat-scheme='dark'], [data-native-chat-scheme='dark'] *"
    )
  })
})
