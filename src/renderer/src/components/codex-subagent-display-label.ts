const CODEX_ROOT_AGENT_PATH = '/root/'

export function formatCodexSubagentDisplayLabel(value: string): string {
  const label = value.trim()
  if (!label.startsWith(CODEX_ROOT_AGENT_PATH)) {
    return label
  }
  const pathSegments = label.slice(CODEX_ROOT_AGENT_PATH.length).split('/').filter(Boolean)
  return pathSegments.at(-1) ?? label
}
