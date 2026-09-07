let baseSensitivityCollator: Intl.Collator | undefined
let numericCollator: Intl.Collator | undefined

export function compareBaseSensitivityLocaleText(a: string, b: string): number {
  // Why: stay lazy like localeCompare while resolving ICU options only once.
  baseSensitivityCollator ??= new Intl.Collator(undefined, { sensitivity: 'base' })
  return baseSensitivityCollator.compare(a, b)
}

export function compareNumericLocaleText(a: string, b: string): number {
  numericCollator ??= new Intl.Collator(undefined, { numeric: true })
  return numericCollator.compare(a, b)
}
