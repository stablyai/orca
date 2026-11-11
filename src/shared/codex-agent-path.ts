export function codexSubagentPathSegments(agentPath: string | null): string[] {
  return agentPath === null ? [] : agentPath.split('/').filter((part) => part.length > 0)
}

/** The path below the root agent: nested children keep their parents so siblings with the same leaf stay distinct. */
export function codexSubagentPathLabel(agentPath: string | null): string | null {
  const segments = codexSubagentPathSegments(agentPath).map((part) => part.trim())
  const label = (segments[0] === 'root' ? segments.slice(1) : segments)
    .filter((part) => part.length > 0)
    .join('/')
  return label.length > 0 ? label : null
}
