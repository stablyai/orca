export const WORKSPACE_SOURCE_VALUES = [
  'command_palette',
  'sidebar',
  'shortcut',
  'drag_drop',
  'onboarding',
  'terminal_context_menu',
  'unknown'
] as const

export type WorkspaceSource = (typeof WORKSPACE_SOURCE_VALUES)[number]
