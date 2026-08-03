// ---------------------------------------------------------------------------
// Browser action recorder — stream-event compact formatters
//
// One-line summaries for the manual-interaction, console, network-request, and
// network-summary steps streamed from the main process. Used by both the
// compact markdown log and the tray list.
// ---------------------------------------------------------------------------

import type {
  BrowserRecorderConsoleEntry,
  BrowserRecorderElementProps,
  BrowserRecorderInteraction,
  BrowserRecorderNetworkRequest,
  BrowserRecorderNetworkSummary
} from '../../../../shared/browser-recorder-automation'
import { inlineCode, inlineText } from './browser-recorder-text'

/** Compact element props fragment: `[.btn,.btn-primary "Kaydet"]` or ''. */
export function elementPropsSuffix(element: BrowserRecorderElementProps | undefined): string {
  if (!element) {
    return ''
  }
  const parts: string[] = []
  if (element.classes.length > 0) {
    parts.push(`.${element.classes.join(',.')}`)
  }
  if (element.text) {
    parts.push(`"${element.text}"`)
  }
  if (element.styles.length > 0) {
    parts.push(element.styles.join(';'))
  }
  return parts.length > 0 ? ` [${parts.join(' ')}]` : ''
}

export function formatInteractionSummary(interaction: BrowserRecorderInteraction): string {
  const props = elementPropsSuffix(interaction.element)
  switch (interaction.kind) {
    case 'click': {
      const coords =
        interaction.x != null && interaction.y != null ? ` (${interaction.x},${interaction.y})` : ''
      return `click ${interaction.target ?? `${interaction.x ?? 0},${interaction.y ?? 0}`}${coords}${props}`
    }
    case 'type':
      return `type "${interaction.text ?? ''}" into ${interaction.target ?? 'body'}${props}`
    case 'keydown':
      return `key ${interaction.key ?? ''}${props}`
    case 'hover':
      return `hover ${interaction.target ?? ''}${props}`
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
  const label = request.kind === 'frame' ? 'frame' : 'request'
  const parts: string[] = [
    `${label} ${request.method} ${inlineCode(inlineText(request.url, 80))} → ${request.status ?? 'pending'}${request.durationMs != null ? ` (${request.durationMs}ms)` : ''}`
  ]
  if (request.origin) {
    parts.push(`fn: ${inlineText(request.origin, 90)}`)
  }
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
