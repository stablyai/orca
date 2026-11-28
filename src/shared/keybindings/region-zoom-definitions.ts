import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

export const REGION_ZOOM_DEFINITIONS = (
  [
    ['zoom.sidebar.in', 'Zoom in on sidebar', 'Mod+Shift+F10'],
    ['zoom.sidebar.out', 'Zoom out of sidebar', 'Mod+Shift+F8'],
    ['zoom.sidebar.reset', 'Reset sidebar zoom', 'Mod+Shift+F9'],
    ['zoom.panel.in', 'Zoom in on panels', 'Mod+F10'],
    ['zoom.panel.out', 'Zoom out of panels', 'Mod+F8'],
    ['zoom.panel.reset', 'Reset panel zoom', 'Mod+F9']
  ] as const
).map(([id, title, binding]): KeybindingDefinition => ({
  id,
  title,
  group: 'Global',
  scope: 'global',
  allowInTerminal: true,
  runsInChatPrompt: true,
  searchKeywords: ['shortcut', 'zoom', 'scale'],
  defaultBindings: platformBindings([binding])
}))
