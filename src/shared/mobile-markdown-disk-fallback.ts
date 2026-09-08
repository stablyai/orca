export const MARKDOWN_RENDERER_UNAVAILABLE = 'renderer_unavailable'
export const MARKDOWN_TOO_LARGE_READ_ONLY_REASON = 'File too large for mobile preview'

/** What a markdown tab reads as when only the file on disk is reachable. */
export function buildMarkdownDiskFallbackDoc(args: {
  content: string
  truncated: boolean
  tabIsDirty: boolean
}) {
  const readOnlyReason = args.truncated
    ? MARKDOWN_TOO_LARGE_READ_ONLY_REASON
    : args.tabIsDirty
      ? 'Desktop has unsaved changes. Showing disk content.'
      : 'Editing needs Orca desktop running.'
  return {
    status: 'ready' as const,
    content: args.content,
    localContent: args.content,
    baseVersion: '',
    isDirty: false,
    editable: false,
    stale: args.tabIsDirty,
    readOnlyReason
  }
}
