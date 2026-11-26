// Pure (no Node imports): the renderer validates and suggests copy names with these too.

export const COPY_NAME_PATTERN = /^[A-Za-z0-9-]{1,24}$/

/** `name`, or `name-<n>` (shortened to stay within 24 characters) when a copy already has it. */
export function uniqueCopyName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((entry) => entry.toLowerCase()))
  if (!used.has(name.toLowerCase())) {
    return name
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const candidate = `${name.slice(0, 24 - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!used.has(candidate.toLowerCase())) {
      return candidate
    }
  }
}

/** A stream's last path segment (`//depot/main_wt_fix` → `main_wt_fix`); streams in a depot share the prefix. */
export function streamShortName(stream: string): string {
  return stream.slice(stream.lastIndexOf('/') + 1) || stream
}
