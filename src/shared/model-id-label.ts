// Why: kept out of `commit-message-agent-spec.ts` so the renderer's session-option
// path can label model ids without pulling in the commit-message agent registry.
export function labelFromModelId(id: string): string {
  return id
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
