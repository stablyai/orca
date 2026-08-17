export type KeyboardLayoutKeyCharacters = {
  unmodified: string | null
  shifted: string | null
}

export type KeyboardLayoutSnapshot = {
  inputSourceId: string | null
  layoutSourceId?: string | null
  keyCharacters: Record<string, KeyboardLayoutKeyCharacters>
}
