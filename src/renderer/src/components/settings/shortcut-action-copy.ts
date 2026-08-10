import { translate } from '@/i18n/i18n'
import type { KeybindingActionId } from '../../../../shared/keybindings'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import type { ShortcutFilter } from './ShortcutFilterRail'

const GROUP_KEYS: Record<string, string> = {
  Global: 'settings.shortcuts.groups.global',
  Tabs: 'settings.shortcuts.groups.tabs',
  'Tab Navigation': 'settings.shortcuts.groups.tabNavigation',
  'Quick Commands': 'settings.shortcuts.groups.quickCommands',
  Browser: 'settings.shortcuts.groups.browser',
  Editors: 'settings.shortcuts.groups.editors',
  'File Explorer': 'settings.shortcuts.groups.fileExplorer',
  Settings: 'settings.shortcuts.groups.settings',
  'Terminal Panes': 'settings.shortcuts.groups.terminalPanes',
  Agents: 'settings.shortcuts.groups.agents'
}

export function translateShortcutActionTitle(actionId: string, fallback: string): string {
  if (actionId.startsWith('tab.newAgent.')) {
    const agent = actionId.slice('tab.newAgent.'.length)
    const agentName =
      TUI_AGENT_DISPLAY_NAMES[agent as keyof typeof TUI_AGENT_DISPLAY_NAMES] ?? agent
    return translate('settings.shortcuts.actions.tab.newAgentNamed', 'New {{agent}} tab', {
      agent: agentName
    })
  }
  return translate(`settings.shortcuts.actions.${actionId}`, fallback)
}

const KEYBINDING_VALIDATION_ERRORS: Record<string, { key: string; fallback: string }> = {
  'Use a shortcut like Ctrl+Shift+P or Cmd+K.': {
    key: 'settings.shortcuts.validation.exampleChord',
    fallback: 'Use a shortcut like Ctrl+Shift+P or Cmd+K.'
  },
  'Use either Mod or a platform-specific modifier, not both.': {
    key: 'settings.shortcuts.validation.modOrPlatform',
    fallback: 'Use either Mod or a platform-specific modifier, not both.'
  },
  'Include at least one modifier key.': {
    key: 'settings.shortcuts.validation.needModifier',
    fallback: 'Include at least one modifier key.'
  },
  'Pick a number key 1–9 with a modifier, like Cmd+1 or Ctrl+1.': {
    key: 'settings.shortcuts.validation.digitIndex',
    fallback: 'Pick a number key 1–9 with a modifier, like Cmd+1 or Ctrl+1.'
  },
  'Press a key, not only a modifier.': {
    key: 'settings.shortcuts.validation.needNonModifier',
    fallback: 'Press a key, not only a modifier.'
  }
}

export function translateKeybindingValidationError(message: string): string {
  const known = KEYBINDING_VALIDATION_ERRORS[message]
  return known ? translate(known.key, known.fallback) : message
}

export function translateShortcutGroupTitle(group: string): string {
  const key = GROUP_KEYS[group]
  return key ? translate(key, group) : group
}

export function translateShortcutFilterLabel(filter: ShortcutFilter): string {
  switch (filter) {
    case 'all':
      return translate('settings.shortcuts.filters.all', 'All')
    case 'modified':
      return translate('settings.shortcuts.filters.modified', 'Modified')
    case 'unassigned':
      return translate('settings.shortcuts.filters.unassigned', 'Unassigned')
    case 'conflicts':
      return translate('settings.shortcuts.filters.conflicts', 'Conflicts')
  }
}

export function translateShortcutConflictWarning(
  bindingLabel: string,
  actionTitles: string
): string {
  return translate('settings.shortcuts.conflict', '{{binding}} conflicts with {{titles}}.', {
    binding: bindingLabel,
    titles: actionTitles
  })
}

export function translateShortcutMutationFailure(
  error: unknown,
  key: string,
  fallback: string
): string {
  return error instanceof Error ? error.message : translate(key, fallback)
}

export function translateShortcutConflictActionTitles(
  actionIds: readonly string[],
  excludedActionId: string,
  definitionsByAction: ReadonlyMap<string, { id: string; title: string }>
): string {
  return actionIds
    .filter((id) => id !== excludedActionId)
    .map((id) => {
      const definition = definitionsByAction.get(id)
      return definition ? translateShortcutActionTitle(definition.id, definition.title) : id
    })
    .join(', ')
}

export function translateKeybindingActionId(
  actionId: KeybindingActionId,
  fallback: string
): string {
  return translateShortcutActionTitle(actionId, fallback)
}
