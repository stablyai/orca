import type {
  BrowserRecorderElementSummary,
  BrowserRecorderStep,
  BrowserRecorderStepDetail
} from './browser-recorder-types'
import type { BrowserRecorderAutomationAction } from '../../../../shared/browser-recorder-automation'
import {
  formatConsoleEntryLines,
  formatInteractionLines,
  formatInteractionSummary,
  formatNetworkSummaryLines,
  interactionDetailHeading
} from './browser-recorder-stream-output'
import { formatPageUrl, formatTime, inlineCode, inlineText } from './browser-recorder-text'

function elementLabel(element: BrowserRecorderElementSummary): string {
  const accessibleName = element.accessibleName?.trim()
  const base = accessibleName
    ? `${element.tagName} "${accessibleName}"`
    : element.textSnippet.trim()
      ? `${element.tagName} "${inlineText(element.textSnippet).slice(0, 60)}"`
      : element.tagName
  return base
}

function formatElementLines(element: BrowserRecorderElementSummary): string[] {
  const rect = element.rectViewport
  const lines = [`**Element:** ${elementLabel(element)}`]
  lines.push(`**Selector:** ${inlineCode(element.selector)}`)
  if (element.elementPath) {
    lines.push(`**Location:** ${inlineCode(element.elementPath)}`)
  }
  lines.push(
    `**Bounds:** x=${Math.round(rect.x)}, y=${Math.round(rect.y)}, ${Math.round(rect.width)}x${Math.round(rect.height)}`
  )
  if (element.cssClasses) {
    lines.push(`**Classes:** ${inlineCode(element.cssClasses)}`)
  }
  if (element.textSnippet) {
    lines.push(`**Text:** "${inlineText(element.textSnippet)}"`)
  }
  return lines
}

export function formatBrowserRecorderStepDetail(
  step: BrowserRecorderStep,
  index: number
): string[] {
  const detail = step.detail
  const lines: string[] = []
  const heading = detailHeading(detail)
  lines.push(`### ${index + 1}. ${heading}`)
  lines.push(`**Time:** ${formatTime(step.createdAt)}`)
  lines.push(`**Page:** ${inlineText(step.pageUrl)}`)
  if (step.pageTitle && step.pageTitle !== step.pageUrl) {
    lines.push(`**Page title:** ${inlineText(step.pageTitle)}`)
  }

  switch (detail.kind) {
    case 'recording-started':
      break
    case 'navigation':
      lines.push(`**From:** ${inlineText(detail.fromUrl)}`)
      lines.push(`**To:** ${inlineText(detail.toUrl)}`)
      break
    case 'element-selected':
      lines.push(...formatElementLines(detail.element))
      break
    case 'annotation-added':
      lines.push(...formatElementLines(detail.element))
      lines.push(`**Intent:** ${detail.intent}`)
      lines.push(`**Feedback:** ${inlineText(detail.comment)}`)
      break
    case 'automation-action':
      lines.push(...formatAutomationActionLines(detail.action))
      break
    case 'interaction':
      lines.push(...formatInteractionLines(detail.interaction))
      break
    case 'console':
      lines.push(...formatConsoleEntryLines(detail.entry))
      break
    case 'network-summary':
      lines.push(...formatNetworkSummaryLines(detail.summary))
      break
  }
  return lines
}

function formatAutomationActionLines(action: BrowserRecorderAutomationAction): string[] {
  const lines: string[] = []
  lines.push(`**Method:** ${inlineCode(action.method)}`)
  if (action.target.kind !== 'none' && action.target.value) {
    lines.push(`**Target:** ${action.target.kind} ${inlineCode(action.target.value)}`)
  }
  const paramEntries = Object.entries(action.params)
  if (paramEntries.length > 0) {
    lines.push(
      `**Params:** ${paramEntries
        .map(([key, value]) => `${key}=${inlineText(String(value ?? ''))}`)
        .join(', ')}`
    )
  }
  lines.push(
    `**Result:** ${action.ok ? 'ok' : 'error'} (${action.durationMs}ms)${
      action.error ? ` — ${inlineText(action.error)}` : ''
    }`
  )
  if (action.urlAfter && action.urlAfter !== action.page.url) {
    lines.push(`**URL:** ${inlineText(action.page.url)} → ${inlineText(action.urlAfter)}`)
  } else if (action.urlAfter) {
    lines.push(`**URL:** ${inlineText(action.urlAfter)}`)
  }
  if (action.titleAfter && action.titleAfter !== action.page.title) {
    lines.push(`**Title:** ${inlineText(action.page.title)} → ${inlineText(action.titleAfter)}`)
  }
  if (action.domDiff && action.domDiff.changed.length > 0) {
    const diff = action.domDiff
    const parts: string[] = []
    if (diff.urlChanged) {
      parts.push('url')
    }
    if (diff.titleChanged) {
      parts.push('title')
    }
    if (diff.textLengthDelta !== 0) {
      parts.push(`text ${diff.textLengthDelta > 0 ? '+' : ''}${diff.textLengthDelta}`)
    }
    if (diff.interactiveDelta !== 0) {
      parts.push(`interactive ${diff.interactiveDelta > 0 ? '+' : ''}${diff.interactiveDelta}`)
    }
    if (diff.inputsChanged) {
      parts.push('inputs')
    }
    if (parts.length > 0) {
      lines.push(`**DOM changed:** ${parts.join(', ')}`)
    }
    const shownChanges = diff.inputChanges.slice(0, 5)
    if (shownChanges.length > 0) {
      const changeLines = shownChanges.map(
        (change) =>
          `${inlineCode(change.label)}: "${inlineText(change.before)}" → "${inlineText(change.after)}"`
      )
      const hidden = diff.inputChanges.length - shownChanges.length
      if (hidden > 0) {
        changeLines.push(`+${hidden} more`)
      }
      lines.push('**Fields:**')
      lines.push(...changeLines.map((line) => `- ${line}`))
    }
  } else if (action.ok && action.domDiff) {
    lines.push('**DOM changed:** none')
  }
  return lines
}

function detailHeading(detail: BrowserRecorderStepDetail): string {
  switch (detail.kind) {
    case 'recording-started':
      return 'Recording started'
    case 'navigation':
      return 'Navigated to a new page'
    case 'element-selected':
      return 'Selected element'
    case 'annotation-added':
      return 'Added annotation'
    case 'automation-action':
      return 'Browser automation action'
    case 'interaction':
      return interactionDetailHeading(detail.interaction)
    case 'console':
      return `Console ${detail.entry.level}`
    case 'network-summary':
      return 'Network summary'
  }
}

/** Formats the recorded session as a self-contained markdown log. */
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

  steps.forEach((step, index) => {
    lines.push(...formatBrowserRecorderStepDetail(step, index))
    lines.push('')
  })

  return lines.join('\n').trimEnd()
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
      return formatInteractionSummary(step.detail.interaction)
    case 'console':
      return `Console ${step.detail.entry.level}: ${inlineText(step.detail.entry.message, 60)}`
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
