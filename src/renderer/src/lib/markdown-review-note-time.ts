// Why: review notes show an absolute "added at" timestamp (not relative) so the
// thread reads like a dated comment log. Uses the runtime locale via
// toLocaleString rather than a translated string — dates are formatted, not
// translated, so this stays out of the i18n catalog.
export function formatReviewNoteTimestamp(createdAt: number | undefined): string {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return ''
  }
  return new Date(createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
