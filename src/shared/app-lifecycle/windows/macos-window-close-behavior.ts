export type MacWindowCloseBehavior = 'close-window' | 'hide-to-menu-bar' | 'quit-app'

export function normalizeMacWindowCloseBehavior(value: unknown): MacWindowCloseBehavior {
  return value === 'hide-to-menu-bar' || value === 'quit-app' ? value : 'close-window'
}
