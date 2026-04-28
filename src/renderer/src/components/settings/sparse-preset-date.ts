export function formatSparsePresetUpdatedAt(timestamp: number): string | null {
  if (!Number.isFinite(timestamp)) {
    return null
  }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}
