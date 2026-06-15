const gitHistoryTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric'
})

export function formatGitHistoryTimestamp(timestamp: number | undefined): string {
  if (!timestamp) {
    return ''
  }
  return gitHistoryTimestampFormatter.format(new Date(timestamp))
}
