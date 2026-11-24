// Agents mark their suggestion inline ("Tabs (Recommended)"); the card shows it as a pill instead.
const RECOMMENDED_SUFFIX = /\s*\((?:recommended)\)\s*$/i

/** The label to show and whether it carried a trailing "(Recommended)"; the answer keeps the full label. */
export function nativeChatQuestionOptionLabel(label: string): {
  shown: string
  recommended: boolean
} {
  const shown = label.replace(RECOMMENDED_SUFFIX, '')
  return shown.length > 0 && shown !== label
    ? { shown, recommended: true }
    : { shown: label, recommended: false }
}
