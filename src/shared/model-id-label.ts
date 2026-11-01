// Keep renderer session-option labels independent of the commit-message agent registry.
export function labelFromModelId(id: string): string {
  return (
    id
      // Ids spell a dotted version with dashes after the name (claude-opus-5-5, grok-4-1-fast);
      // a run after a number (2024-08-06) or with a zero-led part (preview-05-20) is a date.
      .replace(
        /(^|[/-])([a-z]+-)((?:[1-9]\d|\d)(?:-(?:[1-9]\d|\d))+)(?=$|[-/[])/gi,
        (_, start: string, name: string, version: string) =>
          `${start}${name}${version.replace(/-/g, '.')}`
      )
      .replace(/\[(\d+[km])\]$/i, (_, size: string) => ` (${size.toUpperCase()} context)`)
      .split(/[/-]/)
      .filter(Boolean)
      .map((part) => {
        if (/^gpt$/i.test(part)) {
          return 'GPT'
        }
        return part.length <= 3 && /^\d/.test(part)
          ? part.toUpperCase()
          : part.charAt(0).toUpperCase() + part.slice(1)
      })
      .join(' ')
  )
}
