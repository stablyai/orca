export const PRIMARY_SELECTION_MAX_LENGTH = 65_536

let enabled = false
let primarySelectionText = ''

export function setPrimarySelectionEnabled(nextEnabled: boolean): void {
  enabled = nextEnabled
  if (!enabled) {
    primarySelectionText = ''
  }
}

export function isPrimarySelectionEnabled(): boolean {
  return enabled
}

export function getPrimarySelectionText(): string {
  return enabled ? primarySelectionText : ''
}

export function setPrimarySelectionText(text: string): boolean {
  if (!enabled || text.length === 0 || text.length > PRIMARY_SELECTION_MAX_LENGTH) {
    return false
  }
  primarySelectionText = text
  return true
}

export function resetPrimarySelectionForTests(): void {
  enabled = false
  primarySelectionText = ''
}
