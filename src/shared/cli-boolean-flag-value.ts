/**
 * `--flag=value` is split before the boolean lookup, so a boolean flag written
 * that way used to land as the string `'value'` and read as off wherever a
 * consumer tests `=== true`. Both CLI front ends coerce the value through here,
 * so a spelling that means true means true on every transport.
 */
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on'])
const FALSE_VALUES = new Set(['false', '0', 'no', 'off'])

/** `null` when the text is not a boolean spelling; the caller raises its own error type. */
export function parseCliBooleanFlagValue(value: string): boolean | null {
  const normalized = value.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) {
    return true
  }
  if (FALSE_VALUES.has(normalized)) {
    return false
  }
  return null
}

export function cliBooleanFlagValueError(name: string): string {
  return `--${name} is a boolean flag; pass --${name} on its own, or --${name}=true or --${name}=false.`
}
