import { translate } from '@/i18n/i18n'
import { normalizeMatchQuery, scoreQueryTokens } from './query-token-match'
import type { BuiltInWindowsTerminalShell } from '../../../../shared/windows-terminal-shell'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type TabCreateMenuOptionKind =
  | 'go-to-simulator'
  | 'new-browser'
  | 'new-markdown'
  | 'new-simulator'
  | 'new-terminal'
  | 'new-terminal-shell'
  | 'open-markdown'

export type TabCreateMenuOption = {
  id: string
  kind: TabCreateMenuOptionKind
  keywords: readonly string[]
  label: string
  shell?: BuiltInWindowsTerminalShell
}

export type TabCreateMenuOptionsContext = {
  hasNewBrowser: boolean
  hasNewMarkdown: boolean
  hasOpenMarkdown: boolean
  hasSimulator: boolean
  simulatorIsGoTo: boolean
  terminalOnly: boolean
  windowsShellEntries?: readonly { label: string; shell: BuiltInWindowsTerminalShell }[]
}

export const TAB_CREATE_MENU_QUERY_MAX_BYTES = 2 * 1024

export function isTabCreateMenuQueryTooLarge(
  query: string,
  maxBytes = TAB_CREATE_MENU_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}
function scoreMenuOption(query: string, option: TabCreateMenuOption): number {
  const normalizedQuery = normalizeMatchQuery(query)
  if (!normalizedQuery) {
    return 0
  }
  const values = [option.label, ...option.keywords]
  const normalizedLabel = normalizeMatchQuery(option.label)
  if (normalizedQuery === normalizedLabel) {
    return 100
  }
  const tokenMatch = scoreQueryTokens(normalizedQuery, values)
  if (!tokenMatch.allTokensMatched) {
    return 0
  }
  if (normalizedLabel.includes(normalizedQuery) || normalizedQuery.includes(normalizedLabel)) {
    return 80 + tokenMatch.score
  }
  return tokenMatch.score
}

export function buildTabCreateMenuOptions(
  context: TabCreateMenuOptionsContext
): TabCreateMenuOption[] {
  if (context.terminalOnly) {
    return []
  }

  const options: TabCreateMenuOption[] = []

  if (context.windowsShellEntries && context.windowsShellEntries.length > 0) {
    for (const entry of context.windowsShellEntries) {
      const label = `${translate('auto.components.tab.bar.TabBar.7c1313d237', 'New Terminal:')} ${entry.label}`
      options.push({
        id: `new-terminal-shell:${entry.shell}`,
        kind: 'new-terminal-shell',
        label,
        shell: entry.shell,
        keywords: [
          translate('auto.components.tab.bar.tab.create.menu.options.5501c2fb7a', 'terminal'),
          translate('auto.components.tab.bar.tab.create.menu.options.9630dd5494', 'shell'),
          translate('auto.components.tab.bar.tab.create.menu.options.a094576900', 'new terminal'),
          entry.label,
          label
        ]
      })
    }
  } else {
    const label = translate('auto.components.tab.bar.TabBar.d364f3c8d4', 'New Terminal')
    options.push({
      id: 'new-terminal',
      kind: 'new-terminal',
      label,
      keywords: [
        translate('auto.components.tab.bar.tab.create.menu.options.5501c2fb7a', 'terminal'),
        translate('auto.components.tab.bar.tab.create.menu.options.9630dd5494', 'shell'),
        translate('auto.components.tab.bar.tab.create.menu.options.a094576900', 'new terminal'),
        translate('auto.components.tab.bar.tab.create.menu.options.4f23f4d01d', 'new shell')
      ]
    })
  }

  if (context.hasNewBrowser) {
    const label = translate('auto.components.tab.bar.TabBar.4833fb2cbe', 'New Browser Tab')
    options.push({
      id: 'new-browser',
      kind: 'new-browser',
      label,
      keywords: [
        translate('auto.components.tab.bar.tab.create.menu.options.4f2a91e15b', 'browser'),
        translate('auto.components.tab.bar.tab.create.menu.options.6d0e6a4b7a', 'new browser'),
        translate('auto.components.tab.bar.tab.create.menu.options.c87ad57785', 'browser tab'),
        translate('auto.components.tab.bar.tab.create.menu.options.cce7ef1d2c', 'web')
      ]
    })
  }

  if (context.hasNewMarkdown) {
    const label = translate('auto.components.tab.bar.TabBar.3d5d6c960d', 'New Markdown')
    options.push({
      id: 'new-markdown',
      kind: 'new-markdown',
      label,
      keywords: [
        translate('auto.components.tab.bar.tab.create.menu.options.5f17fb9d0c', 'markdown'),
        translate('auto.components.tab.bar.tab.create.menu.options.44caaf7b36', 'md'),
        translate('auto.components.tab.bar.tab.create.menu.options.fb50e3d874', 'new markdown'),
        translate('auto.components.tab.bar.tab.create.menu.options.6d8b6b4117', 'new file'),
        translate('auto.components.tab.bar.tab.create.menu.options.b330f72434', 'mark')
      ]
    })
  }

  if (context.hasOpenMarkdown) {
    const label = translate('auto.components.tab.bar.TabBar.4f327c8b3d', 'Open Markdown...')
    options.push({
      id: 'open-markdown',
      kind: 'open-markdown',
      label,
      keywords: [
        translate('auto.components.tab.bar.tab.create.menu.options.37ff3ddca1', 'open markdown'),
        translate('auto.components.tab.bar.tab.create.menu.options.5f17fb9d0c', 'markdown'),
        translate('auto.components.tab.bar.tab.create.menu.options.44caaf7b36', 'md'),
        translate('auto.components.tab.bar.tab.create.menu.options.164c394bab', 'open file')
      ]
    })
  }

  if (context.hasSimulator) {
    const label = context.simulatorIsGoTo
      ? translate('auto.components.tab.bar.TabBar.b426bb2615', 'Go to Mobile Emulator')
      : translate('auto.components.tab.bar.TabBar.fd2b42aaa3', 'New Mobile Emulator')
    options.push({
      id: context.simulatorIsGoTo ? 'go-to-simulator' : 'new-simulator',
      kind: context.simulatorIsGoTo ? 'go-to-simulator' : 'new-simulator',
      label,
      keywords: [
        translate('auto.components.tab.bar.tab.create.menu.options.bbaf4f85a4', 'mobile emulator'),
        translate('auto.components.tab.bar.tab.create.menu.options.3784b83bd4', 'emulator'),
        translate('auto.components.tab.bar.tab.create.menu.options.a63847a742', 'simulator'),
        translate('auto.components.tab.bar.tab.create.menu.options.1baeb07c17', 'ios simulator'),
        translate('auto.components.tab.bar.tab.create.menu.options.8a580f88cf', 'iphone'),
        translate('auto.components.tab.bar.tab.create.menu.options.7ecdc5ef08', 'ipad'),
        translate('auto.components.tab.bar.tab.create.menu.options.14965cc123', 'mobile')
      ]
    })
  }

  return options
}

export function findMatchingTabCreateMenuOptions(
  query: string,
  options: readonly TabCreateMenuOption[]
): TabCreateMenuOption[] {
  if (isTabCreateMenuQueryTooLarge(query)) {
    return []
  }
  const normalizedQuery = normalizeMatchQuery(query)
  if (!normalizedQuery) {
    return []
  }

  return options
    .map((option, index) => ({ index, option, score: scoreMenuOption(normalizedQuery, option) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score
      }
      return left.index - right.index
    })
    .map((entry) => entry.option)
}
