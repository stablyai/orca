// Keep renderer session-option labels independent of the commit-message agent registry.
export function labelFromModelId(id: string): string {
  return id
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
}
