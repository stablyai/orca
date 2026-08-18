export type BrowserFindSource = {
  browserPageId: string
  browserWorkspaceId: string
}

export function isBrowserFindSource(value: unknown): value is BrowserFindSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const source = value as Partial<BrowserFindSource>
  return (
    typeof source.browserPageId === 'string' &&
    source.browserPageId.length > 0 &&
    typeof source.browserWorkspaceId === 'string' &&
    source.browserWorkspaceId.length > 0
  )
}
