// The translator for callers with no catalog (main, the CLI, agent text): the English with its
// {{slots}} filled in one pass, so a value holding "{{x}}" stays verbatim.
export type CopyTranslate = (
  key: string,
  fallback: string,
  values?: Record<string, unknown>
) => string

export const englishTranslate: CopyTranslate = (_key, fallback, values) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (slot, name: string) =>
    values && Object.hasOwn(values, name) ? String(values[name]) : slot
  )
