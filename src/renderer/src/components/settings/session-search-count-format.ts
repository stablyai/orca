/** Group recognizable session totals; compact potentially million-scale message counts. */
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
