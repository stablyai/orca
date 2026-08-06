import type { BrowserRecorderStep } from './browser-recorder-types'
import type { BrowserRecorderAutomationAction } from '../../../../shared/browser-recorder-automation'
import { groupRecorderSteps } from './browser-recorder-grouping'
import {
  compactConsoleEntry,
  compactNetworkRequest,
  compactNetworkSummary,
  formatInteractionSummary
} from './browser-recorder-stream-output'
import { elementLabel, formatMarkupShapesTree } from './browser-recorder-element-format'
import { formatPageUrl, formatTime, inlineCode, inlineText } from './browser-recorder-text'

/** Format the gap: '' for sub-second, '(+Ns)' for seconds, '(+Ms)' for minutes. */
export function stepGapLabel(currentAt: string, previousAt?: string): string {
  if (!previousAt) {
    return ''
  }
  const gapMs = new Date(currentAt).getTime() - new Date(previousAt).getTime()
  if (!Number.isFinite(gapMs) || gapMs < 1000) {
    return ''
  }
  const seconds = Math.round(gapMs / 1000)
  return seconds >= 60 ? `(+${Math.floor(seconds / 60)}m${seconds % 60}s)` : `(+${seconds}s)`
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

  // Why: grouping lives in one place so the copied markdown log and the tray
  // list always agree on which requests/console messages belong to which
  // trigger. A lead (click/type/key, action, navigation) opens a group; its
  // requests and console messages hang off it until the next lead or a
  // closing step (selection/annotation/network summary). Hover/scroll render
  // on their own line but keep the group open — a click's requests usually
  // arrive after the mouse moved away. Standalone steps render on their line.
  let stepNumber = 0
  let previousAt = startedAt ?? steps[0]?.createdAt
  const gapLabel = (step: BrowserRecorderStep): string => {
    const gap = stepGapLabel(step.createdAt, previousAt)
    previousAt = step.createdAt
    return gap
  }
  const numbered = (step: BrowserRecorderStep, branch: string): string => {
    stepNumber += 1
    const gap = gapLabel(step)
    return `${stepNumber}. ${gap ? `${gap} ` : ''}${branch}${formatCompactStepLine(step)}`
  }
  for (const group of groupRecorderSteps(steps)) {
    if (group.lead) {
      lines.push(numbered(group.lead, ''))
      for (const item of group.items) {
        const branch = item.kind === 'member' ? '  └ ' : ''
        lines.push(numbered(item.step, branch))
      }
    } else {
      for (const item of group.items) {
        lines.push(numbered(item.step, ''))
      }
    }
  }

  // ── session summary block ──
  const summary = computeSessionSummary(steps, startedAt)
  if (summary) {
    lines.push('')
    lines.push(`**Session:** ${summary}`)
  }

  return lines.join('\n').trimEnd()
}

/**
 * One-line session digest: total time, request count, errors, and slow
 * requests so the agent gets context at a glance without scanning the log.
 */
export function computeSessionSummary(
  steps: BrowserRecorderStep[],
  startedAt?: string
): string | null {
  if (steps.length === 0) {
    return null
  }
  const firstAt = startedAt ?? steps[0]?.createdAt
  const lastAt = steps.at(-1)?.createdAt
  const parts: string[] = []
  if (firstAt && lastAt) {
    const durationMs = new Date(lastAt).getTime() - new Date(firstAt).getTime()
    if (Number.isFinite(durationMs) && durationMs >= 1000) {
      const totalSec = Math.round(durationMs / 1000)
      parts.push(
        totalSec >= 60 ? `${Math.floor(totalSec / 60)}m ${totalSec % 60}s` : `${totalSec}s`
      )
    }
  }
  let requests = 0
  let errors = 0
  let warnings = 0
  let slow = 0
  for (const step of steps) {
    if (step.detail.kind === 'network-request') {
      requests += 1
      if (step.detail.request.durationMs != null && step.detail.request.durationMs >= 1000) {
        slow += 1
      }
    }
    if (step.detail.kind === 'console') {
      // Why: warnings are not errors — mixing them would make the agent read
      // the session as more broken than it was.
      if (step.detail.entry.level === 'error') {
        errors += 1
      } else if (step.detail.entry.level === 'warning') {
        warnings += 1
      }
    }
  }
  if (requests > 0) {
    parts.push(`${requests} requests`)
  }
  if (errors > 0) {
    parts.push(`${errors} errors`)
  }
  if (warnings > 0) {
    parts.push(`${warnings} warnings`)
  }
  if (slow > 0) {
    parts.push(`${slow} slow >1s`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/** One compact line describing a step, ending with the page it happened on. */
export function formatCompactStepLine(step: BrowserRecorderStep): string {
  const body = compactStepBody(step)
  const page = inlineText(formatPageUrl(step.pageUrl), 200)
  if (!body) {
    return `@ ${page}`
  }
  // Why: tree steps (markup shapes) span several lines — the page suffix goes
  // on the first line so every numbered line still ends with its location.
  const lines = body.split('\n')
  lines[0] = `${lines[0]} @ ${page}`
  return lines.join('\n')
}

function compactStepBody(step: BrowserRecorderStep): string {
  switch (step.detail.kind) {
    case 'recording-started':
      return 'recording started'
    case 'navigation':
      // Why: backticks keep the URL's & from being auto-linkified into an
      // HTML-escaped markdown link (which truncates at the first &amp;).
      return `navigate ${inlineCode(formatPageUrl(step.detail.fromUrl))} → ${inlineCode(formatPageUrl(step.detail.toUrl))}`
    case 'element-selected':
      return `selected ${elementLabel(step.detail.element)}`
    case 'annotation-added':
      return `annotated ${elementLabel(step.detail.element)} [${step.detail.intent}]: "${inlineText(step.detail.comment, 80)}"`
    case 'annotation-removed':
      return `removed annotation: "${inlineText(step.detail.comment, 80)}"`
    case 'markup':
      return formatMarkupShapesTree(step.detail.shapes)
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
    if (diff.textChange) {
      // Why: the fingerprint diff already reports the delta; the text snippet
      // shows what actually changed, so a tiny edit in a large page is
      // readable without reading the whole DOM. Capped by the main process.
      parts.push(
        `text: "${inlineText(diff.textChange.before, 120)}" → "${inlineText(diff.textChange.after, 120)}"`
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
      return `Annotated ${elementLabel(step.detail.element)} [${step.detail.intent}]`
    case 'annotation-removed':
      return `Removed annotation`
    case 'markup':
      return `Markup copied (${step.detail.shapes.length} shape${step.detail.shapes.length === 1 ? '' : 's'})`
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
