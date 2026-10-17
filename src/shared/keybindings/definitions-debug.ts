import type { KeybindingActionId, KeybindingDefinition, PlatformBindings } from './types'
import { platformBindings } from './definitions-support'

// Why: F-keys produce no text, so VS Code's debug chords may be bare or Shift-only.
function debugRow(
  id: KeybindingActionId,
  title: string,
  bindings: string | PlatformBindings,
  keywords: string,
  scope: 'global' | 'editor' = 'global'
): KeybindingDefinition {
  return {
    id,
    title,
    group: 'Debug',
    scope,
    searchKeywords: ['shortcut', 'debug', 'debugger', ...keywords.split(',')],
    defaultBindings: typeof bindings === 'string' ? platformBindings([bindings]) : bindings,
    allowBareKeybindings: true
  }
}

// Why: Linux/Windows F11 is the native View menu's Toggle Full Screen accelerator, which fires first; Orca keeps it.
const STEP_INTO: PlatformBindings = { darwin: ['F11'], linux: [], win32: [] }

export const DEBUG_KEYBINDING_ACTION_IDS = [
  'debug.startOrContinue',
  'debug.stop',
  'debug.restart',
  'debug.pause',
  'debug.stepOver',
  'debug.stepInto',
  'debug.stepOut',
  'debug.toggleBreakpoint'
] as const satisfies readonly KeybindingActionId[]

export type DebugKeybindingActionId = (typeof DEBUG_KEYBINDING_ACTION_IDS)[number]

export const KEYBINDING_DEFINITION_DEBUG: readonly KeybindingDefinition[] = [
  debugRow('debug.startOrContinue', 'Start or Continue Debugging', 'F5', 'start,continue,run'),
  debugRow('debug.stop', 'Stop Debugging', 'Shift+F5', 'stop,terminate'),
  debugRow('debug.restart', 'Restart Debugging', 'Mod+Shift+F5', 'restart'),
  debugRow('debug.pause', 'Pause', 'F6', 'pause,break'),
  debugRow('debug.stepOver', 'Step Over', 'F10', 'step,over,next'),
  debugRow('debug.stepInto', 'Step Into', STEP_INTO, 'step,into'),
  debugRow('debug.stepOut', 'Step Out', 'Shift+F11', 'step,out'),
  debugRow('debug.toggleBreakpoint', 'Toggle Breakpoint', 'F9', 'breakpoint,toggle', 'editor')
]
