// English rendering of shared copy tables whose counted phrases carry one/other forms.

/** A counted phrase; translated surfaces pick the reader's CLDR form from `count`. */
export type CountedCopy = { readonly one: string; readonly other: string }

/** `{{value0}}` is a phrase already said or a number; `{{count}}` selects and fills the plural form. */
export type CopyValues = { value0?: string | number; count?: number }

export function englishCopyText(entry: string | CountedCopy, values?: CopyValues): string {
  const text = typeof entry === 'string' ? entry : values?.count === 1 ? entry.one : entry.other
  if (values === undefined) {
    return text
  }
  // A replacer function, so a task's own `$&` is never read as a pattern.
  return text.replaceAll(/\{\{(value0|count)\}\}/g, (placeholder, name) => {
    const value = name === 'count' ? values.count : values.value0
    return value === undefined ? placeholder : String(value)
  })
}
