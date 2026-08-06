// Element/shape label formatting for recorder log lines.
//
// Both the element picker steps and the markup shape tree render elements as
// `tag "accessible name" (selector-suffix)` — the selector is shortened to its
// most specific trailing fragment so the line stays short. Markup shapes
// additionally carry geometry and the element they point at, rendered as a
// tree hanging off the numbered markup lead.
import type {
  BrowserRecorderElementSummary,
  BrowserRecorderMarkupElement,
  BrowserRecorderMarkupShapeLog
} from './browser-recorder-types'
import { inlineText } from './browser-recorder-text'

export function elementLabel(element: BrowserRecorderElementSummary): string {
  const accessibleName = element.accessibleName?.trim()
  const base = accessibleName
    ? `${element.tagName} "${accessibleName}"`
    : element.textSnippet.trim()
      ? `${element.tagName} "${inlineText(element.textSnippet).slice(0, 60)}"`
      : element.tagName
  const suffix = selectorSuffix(element.tagName, element.selector)
  return suffix ? `${base} (${suffix})` : base
}

function markupElementLabel(element: BrowserRecorderMarkupElement): string {
  const accessibleName = element.accessibleName?.trim()
  const base = accessibleName
    ? `${element.tagName} "${accessibleName}"`
    : element.textSnippet.trim()
      ? `${element.tagName} "${inlineText(element.textSnippet, 40)}"`
      : element.tagName
  const suffix = selectorSuffix(element.tagName, element.selector)
  return suffix ? `${base} (${suffix})` : base
}

// Why: the selector often starts with the tag and may chain ancestors
// (body > form > button#save); show only the most specific trailing fragment
// so the log line stays short while still identifying the element.
function selectorSuffix(tagName: string, selector: string): string {
  const last = selector.split('>').at(-1)?.trim() ?? selector
  return last.replace(new RegExp(`^${tagName}`), '')
}

// Why: markup logs the drawn shapes as text — geometry plus the DOM element
// each shape points at — so an agent that only sees the copied markdown log
// still learns what the scribble means without the screenshot. Rendered as a
// tree: one line per shape hanging off the markup lead.
const MARKUP_LOG_MAX_SHAPES = 10

export function formatMarkupShapesTree(shapes: readonly BrowserRecorderMarkupShapeLog[]): string {
  if (shapes.length === 0) {
    return 'markup (empty)'
  }
  const head = `markup (${shapes.length} shape${shapes.length === 1 ? '' : 's'})`
  const rows = shapes
    .slice(0, MARKUP_LOG_MAX_SHAPES)
    .map((shape) => `  └ ${formatMarkupShape(shape)}`)
  if (shapes.length > MARKUP_LOG_MAX_SHAPES) {
    rows.push(`  └ +${shapes.length - MARKUP_LOG_MAX_SHAPES} more`)
  }
  return [head, ...rows].join('\n')
}

function formatMarkupShape(shape: BrowserRecorderMarkupShapeLog): string {
  const element = shape.element ? ` → ${markupElementLabel(shape.element)}` : ''
  switch (shape.kind) {
    case 'pen':
    case 'highlight':
      return `${shape.kind} ${shape.pointCount ?? 0}pts${element}`
    case 'arrow':
      return `arrow (${formatPoint(shape.from)})→(${formatPoint(shape.to)})${element}`
    case 'rect':
    case 'ellipse':
      return `${shape.kind} (${formatPoint(shape.from)} → ${formatPoint(shape.to)})${element}`
    case 'text':
      return `text "${inlineText(shape.text ?? '', 40)}" @ ${formatPoint(shape.at)}${element}`
  }
}

function formatPoint(point: { x: number; y: number } | undefined): string {
  return point ? `${Math.round(point.x)},${Math.round(point.y)}` : '?,?'
}
