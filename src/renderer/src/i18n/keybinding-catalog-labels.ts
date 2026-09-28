import type { KeybindingDefinition } from '../../../shared/keybindings'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from './i18n'

const AGENT_TAB_ID_PREFIX = 'tab.newAgent.'

/** Whether `value` is a key of `TUI_AGENT_DISPLAY_NAMES`, narrowing it to `TuiAgent`. */
function isTuiAgent(value: string): value is TuiAgent {
  return Object.hasOwn(TUI_AGENT_DISPLAY_NAMES, value)
}

/** Why: keybinding definitions live in src/shared, which main-process code
 *  also imports, so they cannot call the renderer-only translate(). Localize
 *  their display strings here instead, keyed by the definition id (itself
 *  dotted, so it nests naturally under auto.lib.keybindings.titles like the
 *  id's own structure, e.g. 'floatingTerminal.toggle' ->
 *  ...titles.floatingTerminal.toggle). One definition is generated per
 *  installed TUI agent (id `tab.newAgent.<agent>`), so a per-id catalog entry
 *  can't cover it; only the agent's own (never-translated) display name
 *  varies, so that case translates the surrounding sentence once and
 *  interpolates the name in. */
export function translateKeybindingTitle(
  definition: Pick<KeybindingDefinition, 'id' | 'title'>
): string {
  if (definition.id.startsWith(AGENT_TAB_ID_PREFIX)) {
    const agentKey = definition.id.slice(AGENT_TAB_ID_PREFIX.length)
    if (isTuiAgent(agentKey)) {
      return translate('auto.lib.keybindings.titles.newAgentTab', 'New {{value0}} tab', {
        value0: TUI_AGENT_DISPLAY_NAMES[agentKey]
      })
    }
  }
  return translate(`auto.lib.keybindings.titles.${definition.id}.title`, definition.title)
}

const GROUP_CATALOG_KEY_BY_TITLE: Record<string, string> = {
  Global: 'global',
  Tabs: 'tabs',
  'Tab Navigation': 'tabNavigation',
  Browser: 'browser',
  Editors: 'editors',
  'File Explorer': 'fileExplorer',
  Settings: 'settings',
  'Terminal Panes': 'terminalPanes',
  'Quick Commands': 'quickCommands',
  Agents: 'agents'
}

/** Translates a `KeybindingDefinition.group` title, or returns it unchanged
 *  if it isn't one of the known groups. */
export function translateKeybindingGroupTitle(groupTitle: string): string {
  const catalogKey = GROUP_CATALOG_KEY_BY_TITLE[groupTitle]
  if (!catalogKey) {
    return groupTitle
  }
  return translate(`auto.lib.keybindings.groups.${catalogKey}`, groupTitle)
}
