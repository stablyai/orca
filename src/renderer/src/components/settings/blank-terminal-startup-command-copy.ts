import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getBlankTerminalStartupCommandTitle(): string {
  return translate(
    'auto.components.settings.blank-terminal-startup-command-copy.b19b745e02',
    'Blank terminal startup command'
  )
}

export function getBlankTerminalStartupCommandDescription(): string {
  return translate(
    'auto.components.settings.blank-terminal-startup-command-copy.0b75fc54bd',
    'Typed into every new terminal that opens without an agent, after the shell is ready (for example a shell alias like tc). Leave empty to start a plain shell.'
  )
}

export function getBlankTerminalStartupCommandSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.ea6ec81e98', fallback: 'startup' },
    { key: 'auto.components.settings.agents.search.16815561cc', fallback: 'blank terminal' },
    { key: 'auto.components.settings.agents.search.2cf0f50b9a', fallback: 'new terminal' },
    { key: 'auto.components.settings.agents.search.356ba2a82d', fallback: 'shell' },
    { key: 'auto.components.settings.agents.search.f0d2803403', fallback: 'alias' },
    { key: 'auto.components.settings.agents.search.167daeb5e9', fallback: 'command' }
  ])
}
