import {
  ALL_TUI_AGENTS,
  TUI_AGENT_DISPLAY_NAMES
} from '../agent-launch/catalog/tui-agent-display-names'
import type {
  AgentTabActionId,
  KeybindingActionId,
  KeybindingDefinition,
  KeybindingOverrides,
  PluginKeybindingActionId
} from './types'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { KEYBINDING_DEFINITION_CORE_1 } from './definitions-core-1'
import { KEYBINDING_DEFINITION_CORE_2 } from './definitions-core-2'
import { KEYBINDING_DEFINITION_CORE_3 } from './definitions-core-3'
import { KEYBINDING_DEFINITION_CORE_4 } from './definitions-core-4'

export function agentTabActionId(agent: TuiAgent): AgentTabActionId {
  return `tab.newAgent.${agent}`
}

function buildAgentTabKeybindingDefinitions(): KeybindingDefinition[] {
  return ALL_TUI_AGENTS.map((agent) => ({
    id: agentTabActionId(agent),
    title: `New ${TUI_AGENT_DISPLAY_NAMES[agent]} tab`,
    group: 'Agents',
    scope: 'tabs',
    searchKeywords: [
      'shortcut',
      'tab',
      'agent',
      'new',
      'launch',
      agent,
      TUI_AGENT_DISPLAY_NAMES[agent].toLowerCase()
    ],
    defaultBindings: { darwin: [], linux: [], win32: [] }
  }))
}

export const KEYBINDING_DEFINITIONS: readonly KeybindingDefinition[] = [
  ...KEYBINDING_DEFINITION_CORE_1,
  ...KEYBINDING_DEFINITION_CORE_2,
  ...KEYBINDING_DEFINITION_CORE_3,
  ...KEYBINDING_DEFINITION_CORE_4,
  ...buildAgentTabKeybindingDefinitions()
]

/** Inherited by pre-rollout profiles; explicit shared shortcuts take precedence. */
export const LEGACY_TAB_SWITCH_BINDINGS: Readonly<Partial<Record<KeybindingActionId, string[]>>> = {
  'tab.nextSameType': ['Mod+Shift+BracketRight'],
  'tab.previousSameType': ['Mod+Shift+BracketLeft'],
  'tab.nextAllTypes': ['Mod+Alt+BracketRight'],
  'tab.previousAllTypes': ['Mod+Alt+BracketLeft']
}

export function getLegacySearchBindings(platform: NodeJS.Platform): KeybindingOverrides {
  return {
    'worktree.palette': [platform === 'darwin' ? 'Mod+J' : 'Mod+Shift+J'],
    'terminal.clear': ['Mod+K']
  }
}

export const DEFINITIONS_BY_ID = new Map<KeybindingActionId, KeybindingDefinition>(
  KEYBINDING_DEFINITIONS.map((definition) => [definition.id, definition])
)

const DEFINITION_IDS = new Set<KeybindingActionId>(
  KEYBINDING_DEFINITIONS.map((definition) => definition.id)
)

export {
  DIGIT_INDEX_ACTION_IDS,
  DIGIT_INDEX_KEY_PATTERN,
  isDigitIndexActionId,
  getKeybindingPlatform
} from './definitions-support'

export function isKeybindingActionId(value: string): value is KeybindingActionId {
  return DEFINITION_IDS.has(value as KeybindingActionId) || isPluginKeybindingActionId(value)
}

export function isPluginKeybindingActionId(value: string): value is PluginKeybindingActionId {
  return (
    value.length <= 400 &&
    /^plugin:[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(
      value
    )
  )
}

export function getKeybindingDefinition(actionId: KeybindingActionId): KeybindingDefinition | null {
  return DEFINITIONS_BY_ID.get(actionId) ?? null
}
