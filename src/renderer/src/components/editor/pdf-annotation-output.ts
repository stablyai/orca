import type { PdfAnnotation, PdfRegion, PdfSourceRange } from '@/store/slices/pdf-annotations'
import { inlineText } from '../browser-pane/annotate/browser-annotation-output'

const TITLE_QUOTE_MAX_LENGTH = 60

function formatRegion(region: PdfRegion): string {
  const r = Math.round
  return `page ${region.page} x=${r(region.left)}–${r(region.right)}, y=${r(region.top)}–${r(region.bottom)}`
}

export function pdfAnnotationTitle(
  annotation: Pick<PdfAnnotation, 'page' | 'quote' | 'regions'>
): string {
  const areas = annotation.regions.length > 1 ? ` (${annotation.regions.length} areas)` : ''
  const location = `p.${annotation.page}${areas}`
  const quote = annotation.quote ? inlineText(annotation.quote, TITLE_QUOTE_MAX_LENGTH) : ''
  return quote ? `${location} "${quote}"` : location
}

function formatSourceRange(range: PdfSourceRange): string {
  const lines =
    range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`
  return `${range.path}:${lines}`
}

/**
 * Mirrors browser Design Mode's prompt shape so agents read both the same way. `staleSources`
 * are TeX files edited after the PDF was built, whose SyncTeX lines may no longer match.
 */
export function formatPdfAnnotationsAsMarkdown(
  pdfPath: string,
  annotations: readonly PdfAnnotation[],
  staleSources: readonly string[] = []
): string {
  if (annotations.length === 0) {
    return ''
  }
  const lines: string[] = [`## PDF Feedback: ${pdfPath}`, '', `**File:** ${pdfPath}`, '']
  if (staleSources.length > 0) {
    const files = staleSources.map((path) => `\`${path}\``).join(', ')
    lines.push(
      `**Warning:** ${files} changed after this PDF was built, so the source lines below may be off. Check them before editing, or rebuild and annotate again.`,
      ''
    )
  }
  annotations.forEach((annotation, index) => {
    lines.push(`### ${index + 1}. Page ${annotation.page}`)
    lines.push(`**Intent:** ${annotation.intent}`)
    if (annotation.sources && annotation.sources.length > 0) {
      lines.push(`**Source:** ${annotation.sources.map(formatSourceRange).join('; ')}`)
    }
    if (annotation.regions.length > 0) {
      lines.push(
        `**Areas:** ${annotation.regions.map(formatRegion).join('; ')} (PDF points from the page's top-left)`
      )
    } else {
      lines.push(
        `**Position:** x=${Math.round(annotation.x)}, y=${Math.round(annotation.y)} (PDF points from the page's top-left)`
      )
    }
    if (annotation.quote) {
      // Why: text-layer extraction scrambles math, so dragged-box text is only a hint.
      const label = annotation.regions.length > 0 ? 'Text in areas (approximate)' : 'Text'
      lines.push(`**${label}:** "${inlineText(annotation.quote)}"`)
    }
    lines.push(`**Feedback:** ${inlineText(annotation.comment)}`)
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}
