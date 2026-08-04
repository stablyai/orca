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
    parts.push(`"${inlineText(element.text, 40)}"`)
  }
  if (element.styles.length > 0) {
    parts.push(element.styles.join(';'))
  }
  return parts.length > 0 ? ` [${parts.join(' ')}]` : ''
}

export function formatInteractionSummary(interaction: BrowserRecorderInteraction): string {
  const props = elementPropsSuffix(interaction.element)
  // Why: backticks keep dotted selectors (a.menu-item) from being
  // auto-linkified as if they were URLs.
  switch (interaction.kind) {
    case 'click': {
      const coords =
        interaction.x != null && interaction.y != null ? ` (${interaction.x},${interaction.y})` : ''
      return `click \`${interaction.target ?? `${interaction.x ?? 0},${interaction.y ?? 0}`}\`${coords}${props}`
    }
    case 'type':
      return `type "${interaction.text ?? ''}" into \`${interaction.target ?? 'body'}\`${props}`
    case 'keydown':
      return `key ${interaction.key ?? ''} \`${interaction.target ?? ''}\`${props}`
    case 'hover':
      return `hover \`${interaction.target ?? ''}\`${props}`
    case 'scroll':
      return `scroll x=${interaction.scrollX ?? 0}, y=${interaction.scrollY ?? 0}`
    case 'change':
      // Why: the app's onchange handler receives el.value — show the real
      // value (option value for select, checked state, input value), not just
      // the clicked option label.
      return `change \`${interaction.target ?? ''}\` = ${interaction.value ?? ''}${props}`
    case 'clipboard':
      return `clipboard ${interaction.clipboardAction ?? 'copy'} "${interaction.clipboardText ?? ''}" \`${interaction.target ?? ''}\`${props}`
    case 'ws':
      return `ws: "${interaction.wsText ?? ''}"`
    case 'storage':
      return `storage ${interaction.storageKey ?? ''} = "${interaction.storageValue ?? ''}"`
    case 'select_text':
      return `select_text "${interaction.selectText ?? ''}"`
  }
}

export function compactConsoleEntry(entry: BrowserRecorderConsoleEntry): string {
  const repeats = entry.repeatCount > 1 ? ` ×${entry.repeatCount}` : ''
  const source = entry.source ? ` (${inlineText(entry.source, 120)})` : ''
  // Why: errors are only useful when you can find the throwing function —
  // append the first stack frame when Electron provided one.
  const stack = entry.stack ? ` @ ${inlineText(entry.stack, 140)}` : ''
  return `console ${entry.level}${repeats} "${inlineText(entry.message, 120)}"${source}${stack}`
}

export function compactNetworkRequest(request: BrowserRecorderNetworkRequest): string {
  const label = request.kind === 'frame' ? 'frame' : 'request'
  // Why: slow responses matter for agents replaying the flow — mark requests
  // that took 500ms+ so they stand out without reading every duration.
  const slow = request.durationMs != null && request.durationMs >= 500 ? ' ⚠' : ''
  const parts: string[] = [
    `${label} ${request.method} ${inlineCode(inlineText(request.url, 200))} → ${request.status ?? 'pending'}${slow}${request.durationMs != null ? ` (${request.durationMs}ms)` : ''}`
  ]
  if (request.origin) {
    parts.push(`fn: ${inlineText(request.origin, 90)}`)
  }
  if (request.screenChanged.length > 0) {
    parts.push(`changed: ${request.screenChanged.join(',')}`)
  }
  // Why: the log is saved to a file and handed to an agent, so request/response
  // bodies keep a generous slice — the main process already capped them.
  if (request.postData) {
    parts.push(inlineText(request.postData, 500))
  }
  if (request.response) {
    const truncation = request.responseTruncated ? ` …(${request.responseSize ?? '?'}b)` : ''
    // Why: truncated responses carry a head + tail slice (plus an omitted
    // marker), so the display cap must fit the full preserved budget.
    // Schematized HTML responses are labelled so the reader knows the tags
    // were stripped into visible text + controls.
    const schemaLabel = request.responseSchema === 'html' ? ' [html→text]' : ''
    parts.push(`resp:${schemaLabel} ${inlineText(request.response, 8500)}${truncation}`)
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
