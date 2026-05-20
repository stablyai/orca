export const WORKSPACE_SOURCE_VALUES = [
  'command_palette',
  'sidebar',
  'shortcut',
  'drag_drop',
  'onboarding',
  'unknown'
] as const

export type WorkspaceSource = (typeof WORKSPACE_SOURCE_VALUES)[number]
