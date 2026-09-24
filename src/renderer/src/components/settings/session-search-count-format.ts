/**
 * Counts for the session-search status sentences.
 *
 * Sessions keep their grouping separators because a user recognises their own
 * transcript count; messages run to millions, where the exact figure carries
 * nothing the compact form does not.
 */
const sessionFormatter = new Intl.NumberFormat(undefined, { useGrouping: true })
const messageFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1
})

export function formatSessionCount(sessions: number): string {
  return sessionFormatter.format(Math.max(0, Math.trunc(sessions)))
}

export function formatMessageCount(messages: number): string {
  return messageFormatter.format(Math.max(0, Math.trunc(messages)))
}
