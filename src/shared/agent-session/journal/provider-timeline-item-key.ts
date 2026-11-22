/** The encoded key inside a provider-keyed journal record, independent of session and thread. */
export function spelledProviderTimelineItemKey(recordId: string): string | null {
  if (!recordId.startsWith('item:p:')) {
    return null
  }
  // Parts are URI-encoded; only separators retain literal colons and slashes.
  const scoped = recordId.slice(recordId.lastIndexOf(':') + 1)
  return scoped.slice(scoped.lastIndexOf('/') + 1)
}
