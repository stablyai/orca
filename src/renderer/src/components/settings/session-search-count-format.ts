import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
/** Group recognizable session totals; compact potentially million-scale message counts. */
const SESSION_OPTIONS: Intl.NumberFormatOptions = { useGrouping: true }
const MESSAGE_OPTIONS: Intl.NumberFormatOptions = {
  notation: 'compact',
  maximumFractionDigits: 1
}

export function formatSessionCount(sessions: number): string {
  return uiNumberFormat(SESSION_OPTIONS).format(Math.max(0, Math.trunc(sessions)))
}

export function formatMessageCount(messages: number): string {
  return uiNumberFormat(MESSAGE_OPTIONS).format(Math.max(0, Math.trunc(messages)))
}
