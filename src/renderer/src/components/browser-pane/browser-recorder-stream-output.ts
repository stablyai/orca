// ---------------------------------------------------------------------------
// Browser action recorder — stream-event compact formatters
//
// One-line summaries for the manual-interaction, console, network-request, and
// network-summary steps streamed from the main process. Used by both the
// compact markdown log and the tray list.
// ---------------------------------------------------------------------------

import type {
  BrowserRecorderConsoleEntry,
  BrowserRecorderInteraction,
  BrowserRecorderNetworkRequest,
  BrowserRecorderNetworkSummary
} from '../../../../shared/browser-recorder-automation'
import { inlineCode, inlineText } from './browser-recorder-text'

export function formatInteractionSummary(interaction: BrowserRecorderInteraction): string {
  switch (interaction.kind) {
    case 'click': {
      const coords =
        interaction.x != null && interaction.y != null ? ` (${interaction.x},${interaction.y})` : ''
      return `click ${interaction.target ?? `${interaction.x ?? 0},${interaction.y ?? 0}`}${coords}`
    }
    case 'type':
      return `type "${interaction.text ?? ''}" into ${interaction.target ?? 'body'}`
    case 'keydown':
      return `key ${interaction.key ?? ''}`
    case 'hover':
      return `hover ${interaction.target ?? ''}`
    case 'scroll':
      return `scroll x=${interaction.scrollX ?? 0}, y=${interaction.scrollY ?? 0}`
  }
}

export function compactConsoleEntry(entry: BrowserRecorderConsoleEntry): string {
  const repeats = entry.repeatCount > 1 ? ` ×${entry.repeatCount}` : ''
  const source = entry.source ? ` (${inlineText(entry.source, 40)})` : ''
  return `console ${entry.level}${repeats} "${inlineText(entry.message, 120)}"${source}`
}

export function compactNetworkRequest(request: BrowserRecorderNetworkRequest): string {
  const parts: string[] = [
    `request ${request.method} ${inlineCode(inlineText(request.url, 80))} → ${request.status ?? 'pending'}${request.durationMs != null ? ` (${request.durationMs}ms)` : ''}`
  ]
  if (request.screenChanged.length > 0) {
    parts.push(`changed: ${request.screenChanged.join(',')}`)
  }
  if (request.postData) {
    parts.push(inlineText(request.postData, 120))
  }
  return parts.join(' · ')
}

export function compactNetworkSummary(summary: BrowserRecorderNetworkSummary): string {
  const status =
    summary.byStatus.length > 0
      ? ` (${summary.byStatus.map((bucket) => `${bucket.status}×${bucket.count}`).join(', ')})`
      : ''
  return `network: ${summary.total} requests, ${summary.failed} failed${status}`
}
