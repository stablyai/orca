// The divider a woken cloud pane shows between its restored pre-sleep output and the woken terminal.
import { translate } from '@/i18n/i18n'
import { formatSleptRange } from './cloud-wake-scrollback-render'

/**
 * The divider, dim, between the restored output and the woken terminal. It
 * never wraps: the longest form that fits the pane's columns when it is written, decided once —
 * "── Slept 2:02–2:31 PM · processes stopped ──", then "── Slept 2:02–2:31 PM ──", then
 * "── Slept ──", then a bare rule the pane's width. No ellipsis; the time range is never split.
 */
export function wakeDividerLine(sleptAt: number, wokeAt: number, cols = Infinity): string {
  const range = formatSleptRange(sleptAt, wokeAt)
  const labels = [
    translate(
      'orcaCloudWorkspace.terminal.sleptRangeDivider',
      'Slept {{range}} · processes stopped',
      {
        range
      }
    ),
    translate('orcaCloudWorkspace.terminal.sleptRangeShortDivider', 'Slept {{range}}', { range }),
    translate('orcaCloudWorkspace.terminal.sleptBareDivider', 'Slept')
  ]
  const fitting = labels.map((label) => `── ${label} ──`).find((form) => displayWidth(form) <= cols)
  return `\x1b[0;2m${fitting ?? '─'.repeat(Math.max(1, Math.floor(cols)))}\x1b[0m`
}

/** Columns a divider takes: one per code point (its text has no wide characters). */
export function displayWidth(text: string): number {
  return [...text].length
}
