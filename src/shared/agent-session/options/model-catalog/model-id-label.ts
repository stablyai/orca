// Keep renderer session-option labels independent of the commit-message agent registry.
export function labelFromModelId(id: string): string {
  return (
    id
      // Ids spell a dotted version with dashes after the name (claude-opus-5-5, grok-4-1-fast);
      // a run after a number (2024-08-06), with a zero-led part (preview-05-20) or of only
      // two-digit parts (preview-10-20) is a date.
      .replace(
        /(^|[/-])([a-z]+-)((?:[1-9]\d|\d)(?:-(?:[1-9]\d|\d))+)(?=$|[-/[])/gi,
        (match: string, start: string, name: string, version: string) =>
          /^\d\d(?:-\d\d)+$/.test(version) ? match : `${start}${name}${version.replace(/-/g, '.')}`
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

/** Names a model the agent did not list (a chat's own or saved model) like that agent's listed rows, keeping its date so a pinned snapshot stays distinct from the listed model. */
export function unlistedModelLabel(agent: string, modelId: string): string {
  const label = labelFromModelId(modelId)
  return agent === 'claude' ? withoutClaudeVendor(label) : label
}

/** Drops a leading `Claude ` vendor only before a model name: version-first legacy names keep it (`Claude 3.5 Sonnet`, not `3.5 Sonnet`). */
export function withoutClaudeVendor(label: string): string {
  return label.replace(/^Claude (?=[a-z])/i, '')
}
