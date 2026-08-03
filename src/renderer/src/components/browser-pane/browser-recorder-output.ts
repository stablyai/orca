import type { BrowserRecorderElementSummary, BrowserRecorderStep } from './browser-recorder-types'
import type { BrowserRecorderAutomationAction } from '../../../../shared/browser-recorder-automation'
import {
  compactConsoleEntry,
  compactNetworkRequest,
  compactNetworkSummary,
  formatInteractionSummary
} from './browser-recorder-stream-output'
import { formatPageUrl, formatTime, inlineText } from './browser-recorder-text'

function elementLabel(element: BrowserRecorderElementSummary): string {
  const accessibleName = element.accessibleName?.trim()
  const base = accessibleName
    ? `${element.tagName} "${accessibleName}"`
    : element.textSnippet.trim()
      ? `${element.tagName} "${inlineText(element.textSnippet).slice(0, 60)}"`
      : element.tagName
  return base
}

/**
 * Formats the recorded session as a compact markdown log, one line per step,
 * so it fits more context when handed to an agent. Every line ends with the
 * page it happened on; network requests are indented under the interaction
 * that triggered them (trigger → request tree).
 */
export function formatBrowserRecorderStepsAsMarkdown(
  steps: BrowserRecorderStep[],
  options?: { startedAt?: string }
): string {
  if (steps.length === 0) {
    return ''
  }
  const lines: string[] = ['## Browser Action Log', '']
  const startedAt = options?.startedAt ?? steps[0]?.createdAt
  if (startedAt) {
    lines.push(`**Started:** ${formatTime(startedAt)}`)
  }
  lines.push(`**Steps:** ${steps.length}`)
  const lastStep = steps.at(-1)
  if (lastStep) {
    lines.push(`**Last page:** ${inlineText(formatPageUrl(lastStep.pageUrl))}`)
  }
  lines.push('')

  let pendingTrigger = false
  steps.forEach((step, index) => {
    const kind = step.detail.kind
    const branch = kind === 'network-request' && pendingTrigger ? '  └ ' : ''
    lines.push(`${index + 1}. ${branch}${formatCompactStepLine(step)}`)
    // Why: requests stream in after their click/type trigger; the tree keeps
    // them grouped until the next user interaction breaks the chain. Console
    // noise and later requests do not break it.
    if (kind === 'interaction' || kind === 'automation-action' || kind === 'navigation') {
      pendingTrigger = true
    } else if (kind === 'element-selected' || kind === 'annotation-added') {
      pendingTrigger = false
    }
  })

  return lines.join('\n').trimEnd()
}

/** One compact line describing a step, ending with the page it happened on. */
export function formatCompactStepLine(step: BrowserRecorderStep): string {
  const body = compactStepBody(step)
  const page = inlineText(formatPageUrl(step.pageUrl), 60)
  return body ? `${body} @ ${page}` : `@ ${page}`
}

function compactStepBody(step: BrowserRecorderStep): string {
  switch (step.detail.kind) {
    case 'recording-started':
      return 'recording started'
    case 'navigation':
      return `navigate ${formatPageUrl(step.detail.fromUrl)} → ${formatPageUrl(step.detail.toUrl)}`
    case 'element-selected':
      return `selected ${elementLabel(step.detail.element)}`
    case 'annotation-added':
      return `annotated ${elementLabel(step.detail.element)}: "${inlineText(step.detail.comment, 80)}"`
    case 'automation-action':
      return compactAutomationAction(step.detail.action)
    case 'interaction':
      return formatInteractionSummary(step.detail.interaction)
    case 'console':
      return compactConsoleEntry(step.detail.entry)
    case 'network-request':
      return compactNetworkRequest(step.detail.request)
    case 'network-summary':
      return compactNetworkSummary(step.detail.summary)
  }
}

function compactAutomationAction(action: BrowserRecorderAutomationAction): string {
  const method = action.method.replace(/^browser\./, '')
  const target =
    action.target.kind !== 'none' && action.target.value ? ` ${action.target.value}` : ''
  const result = action.ok
    ? 'ok'
    : `error${action.error ? `: ${inlineText(action.error, 60)}` : ''}`
  const parts: string[] = [`action ${method}${target} ${result} (${action.durationMs}ms)`]
  if (action.domDiff && action.domDiff.changed.length > 0) {
    const diff = action.domDiff
    const changedParts: string[] = []
    if (diff.urlChanged) {
      changedParts.push('url')
    }
    if (diff.titleChanged) {
      changedParts.push('title')
    }
    if (diff.textLengthDelta !== 0) {
      changedParts.push(`text ${diff.textLengthDelta > 0 ? '+' : ''}${diff.textLengthDelta}`)
    }
    if (diff.interactiveDelta !== 0) {
      changedParts.push(
        `interactive ${diff.interactiveDelta > 0 ? '+' : ''}${diff.interactiveDelta}`
      )
    }
    if (diff.inputsChanged) {
      changedParts.push('inputs')
    }
    if (changedParts.length > 0) {
      parts.push(`changed: ${changedParts.join(',')}`)
    }
    const shownChanges = diff.inputChanges.slice(0, 3)
    if (shownChanges.length > 0) {
      parts.push(
        shownChanges
          .map(
            (change) =>
              `${change.label} "${inlineText(change.before, 20)}"→"${inlineText(change.after, 20)}"`
          )
          .join('; ')
      )
    }
  }
  return parts.join(' · ')
}

/** One-line human summary of a step, used by the tray list. */
export function formatBrowserRecorderStepSummary(step: BrowserRecorderStep): string {
  switch (step.detail.kind) {
    case 'recording-started':
      return 'Recording started'
    case 'navigation':
      return `Navigated ${formatPageUrl(step.detail.fromUrl)} → ${formatPageUrl(step.detail.toUrl)}`
    case 'element-selected':
      return `Selected ${elementLabel(step.detail.element)}`
    case 'annotation-added':
      return `Annotated ${elementLabel(step.detail.element)}`
    case 'automation-action':
      return formatAutomationActionSummary(step.detail.action)
    case 'interaction':
      return `User ${formatInteractionSummary(step.detail.interaction)}`
    case 'console':
      return `Console ${step.detail.entry.level}${step.detail.entry.repeatCount > 1 ? ` ×${step.detail.entry.repeatCount}` : ''}: ${inlineText(step.detail.entry.message, 60)}`
    case 'network-request':
      return `Request ${step.detail.request.method} ${inlineText(step.detail.request.url, 60)} → ${step.detail.request.status ?? 'pending'}`
    case 'network-summary':
      return `Network: ${step.detail.summary.total} requests, ${step.detail.summary.failed} failed`
  }
}

function formatAutomationActionSummary(action: BrowserRecorderAutomationAction): string {
  const method = action.method.replace(/^browser\./, '')
  const target =
    action.target.kind !== 'none' && action.target.value ? ` ${action.target.value}` : ''
  const result = action.ok ? '✓' : '✗'
  const detail = action.ok
    ? action.domDiff && action.domDiff.changed.length > 0
      ? ` · ${action.domDiff.changed.join(',')}`
      : ''
    : ` · ${action.error ?? 'error'}`
  return `${method}${target} ${result} (${action.durationMs}ms)${detail}`
}
