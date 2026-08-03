// ---------------------------------------------------------------------------
// Browser action recorder — stream-event formatters
//
// Detail lines, headings, and one-line summaries for the manual-interaction,
// console, and network-summary steps streamed from the main process.
// ---------------------------------------------------------------------------

import type {
  BrowserRecorderConsoleEntry,
  BrowserRecorderInteraction,
  BrowserRecorderNetworkSummary
} from '../../../../shared/browser-recorder-automation'
import { inlineCode } from './browser-recorder-text'

export function formatInteractionLines(interaction: BrowserRecorderInteraction): string[] {
  const lines: string[] = []
  switch (interaction.kind) {
    case 'click':
      lines.push(
        `**At:** ${interaction.x ?? 0},${interaction.y ?? 0}${interaction.target ? ` (${inlineCode(interaction.target)})` : ''}`
      )
      if (interaction.tagName) {
        lines.push(`**Element:** ${inlineCode(interaction.tagName)}`)
      }
      break
    case 'keydown':
      lines.push(`**Key:** ${inlineCode(interaction.key ?? '')}`)
      break
    case 'scroll':
      lines.push(`**To:** x=${interaction.scrollX ?? 0}, y=${interaction.scrollY ?? 0}`)
      break
  }
  return lines
}

export function formatConsoleEntryLines(entry: BrowserRecorderConsoleEntry): string[] {
  const lines: string[] = []
  lines.push(`**Level:** ${entry.level}`)
  lines.push(`**Message:** ${inlineCode(entry.message)}`)
  if (entry.source) {
    lines.push(
      `**Source:** ${inlineCode(entry.source)}${entry.lineNumber ? `:${entry.lineNumber}` : ''}`
    )
  }
  return lines
}

export function formatNetworkSummaryLines(summary: BrowserRecorderNetworkSummary): string[] {
  const lines: string[] = []
  lines.push(`**Requests:** ${summary.total}`)
  lines.push(`**Failed:** ${summary.failed}`)
  if (summary.totalBytes > 0) {
    lines.push(`**Transferred:** ${formatBytes(summary.totalBytes)}`)
  }
  if (summary.byStatus.length > 0) {
    lines.push(
      `**By status:** ${summary.byStatus.map((bucket) => `${bucket.status}×${bucket.count}`).join(', ')}`
    )
  }
  return lines
}

export function interactionDetailHeading(interaction: BrowserRecorderInteraction): string {
  switch (interaction.kind) {
    case 'click':
      return 'Clicked element'
    case 'keydown':
      return 'Key pressed'
    case 'scroll':
      return 'Scrolled page'
  }
}

export function formatInteractionSummary(interaction: BrowserRecorderInteraction): string {
  switch (interaction.kind) {
    case 'click':
      return `Clicked ${interaction.target ?? `${interaction.x ?? 0},${interaction.y ?? 0}`}`
    case 'keydown':
      return `Key ${interaction.key ?? ''}`
    case 'scroll':
      return `Scrolled to ${interaction.scrollX ?? 0},${interaction.scrollY ?? 0}`
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${bytes} B`
}
