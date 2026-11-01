export function codexSubagentPathSegments(agentPath: string | null): string[] {
  return agentPath === null ? [] : agentPath.split('/').filter((part) => part.length > 0)
}

export function codexSubagentPathLabel(agentPath: string | null): string | null {
  const trailing = codexSubagentPathSegments(agentPath).at(-1)?.trim()
  return trailing !== undefined && trailing.length > 0 ? trailing : null
}
