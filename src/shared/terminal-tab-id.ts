export function isValidTerminalTabId(value: string): boolean {
  return value.length > 0 && !value.includes(':')
}
