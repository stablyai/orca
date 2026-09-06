import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from '../tui-agent-display-names'
import type {
  AgentTabActionId,
  KeybindingActionId,
  KeybindingDefinition,
  PluginKeybindingActionId
} from './types'
import type { TuiAgent } from '../tui-agent'
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

/** Pre-swap tab-switch bindings; a one-time migration pins these for pre-release installs so upgrading users keep the shortcuts they learned. */
export const LEGACY_TAB_SWITCH_BINDINGS: Readonly<Partial<Record<KeybindingActionId, string[]>>> = {
  'tab.nextSameType': ['Mod+Shift+BracketRight'],
  'tab.previousSameType': ['Mod+Shift+BracketLeft'],
  'tab.nextAllTypes': ['Mod+Alt+BracketRight'],
  'tab.previousAllTypes': ['Mod+Alt+BracketLeft']
}

export const DEFINITIONS_BY_ID = new Map<KeybindingActionId, KeybindingDefinition>(
  KEYBINDING_DEFINITIONS.map((definition) => [definition.id, definition])
)

const DEFINITION_IDS = new Set<KeybindingActionId>(
  KEYBINDING_DEFINITIONS.map((definition) => definition.id)
)

// Why: these ids are single remappable rows whose chord is a representative — the digit canonicalizes to 1 but the binding fires for any 1-9.
export const DIGIT_INDEX_ACTION_IDS: readonly KeybindingActionId[] = [
  'tab.selectByIndex',
  'workspace.selectByIndex'
]

export const DIGIT_INDEX_KEY_PATTERN = /^[1-9]$/

export function isDigitIndexActionId(actionId: KeybindingActionId): boolean {
  return DIGIT_INDEX_ACTION_IDS.includes(actionId)
}

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

export function getKeybindingPlatform(platform: NodeJS.Platform): 'darwin' | 'linux' | 'win32' {
  return platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux'
}
