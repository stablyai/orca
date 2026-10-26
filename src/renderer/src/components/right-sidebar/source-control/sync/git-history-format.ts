// Include the zone to distinguish repeated times when clocks fall back.
const gitHistoryTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'long'
})

export function formatGitHistoryTimestamp(timestamp: number | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return ''
  }
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return gitHistoryTimestampFormatter.format(date)
}
