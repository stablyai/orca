// Single reading of the default-on setting. Call sites previously mixed
// `?? true` with `!== false`, which disagree when the stored value is null.
export function resolveTerminalInlineImagesEnabled(value: boolean | null | undefined): boolean {
  return value !== false
}
