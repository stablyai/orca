import { formatNativeChatDuration } from './native-chat-turn-status'

export type NativeChatWebSearchResult = { title: string; url: string }

export type NativeChatMcpIdentity = { server: string; tool: string }

export type NativeChatToolMetadata = {
  mcpIdentity?: NativeChatMcpIdentity
  exitCode?: number
  durationMs?: number
  webSearchResults?: NativeChatWebSearchResult[]
}

export function toolExecutionMetadata(item: Record<string, unknown>): NativeChatToolMetadata {
  const durationMs = item.durationMs ?? item.duration_ms
  return {
    ...(typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode)
      ? { exitCode: item.exitCode }
      : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {})
  }
}

export function formatToolDuration(
  durationMs: unknown,
  formatMilliseconds: (value: number) => string = (value) => `${value}ms`
): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return null
  }
  return durationMs < 1000
    ? formatMilliseconds(Math.round(durationMs))
    : formatNativeChatDuration(durationMs / 1000)
}

/** Only explicit provider identity or the reserved MCP prefix proves a tool is MCP. */
export function mcpToolIdentity(
  name: string,
  identity?: NativeChatMcpIdentity
): NativeChatMcpIdentity | null {
  const match = /^mcp__([^\s]+?)__(\S+)$/.exec(name.trim())
  const server = identity?.server ?? match?.[1]
  const tool = identity?.tool ?? match?.[2]
  if (!server || !tool) {
    return null
  }
  const label = server.replace(/[_-]+/g, ' ')
  return {
    server: label.charAt(0).toUpperCase() + label.slice(1),
    tool: tool.replace(/[_-]+/g, ' ')
  }
}

export const MAX_TOOL_SEARCH_RESULTS = 5
const MAX_SEARCH_RESULT_SCAN = 100
const MAX_SEARCH_URL_LENGTH = 2048
const MAX_SEARCH_TITLE_LENGTH = 200

/** A bounded, link-safe subset; the provider's full output remains the detail fallback. */
export function toolWebSearchResults(value: unknown): NativeChatWebSearchResult[] {
  if (!Array.isArray(value)) {
    return []
  }
  const results: NativeChatWebSearchResult[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_SEARCH_RESULT_SCAN)) {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
      continue
    }
    const url = entry.url.trim()
    if (url.length > MAX_SEARCH_URL_LENGTH || !/^https?:\/\//i.test(url)) {
      continue
    }
    try {
      const parsed = new URL(url)
      if (!parsed.hostname || parsed.username || parsed.password || seen.has(parsed.href)) {
        continue
      }
      seen.add(parsed.href)
    } catch {
      continue
    }
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    results.push({ title: title.slice(0, MAX_SEARCH_TITLE_LENGTH) || url, url })
    if (results.length === MAX_TOOL_SEARCH_RESULTS) {
      break
    }
  }
  return results
}
