// Centralize null handling: ?? true and !== false previously disagreed on stored null.
export function resolveTerminalInlineImagesEnabled(value: boolean | null | undefined): boolean {
  return value !== false
}
