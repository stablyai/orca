// Shared so the phone's slash menu sorts with the same comparator.
export { compareBaseSensitivityLocaleText } from '../../../shared/locale-text-collation'

let numericCollator: Intl.Collator | undefined

export function compareNumericLocaleText(a: string, b: string): number {
  numericCollator ??= new Intl.Collator(undefined, { numeric: true })
  return numericCollator.compare(a, b)
}
