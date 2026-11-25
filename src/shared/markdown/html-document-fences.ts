import { createMarkdownFenceTracker } from './markdown-fence-scanner'

const WHOLE_HTML_DOCUMENT = /^\s*<(?:!doctype\s+html|html)[\s>]/i

/** A fence tagged html whose code is a full page (doctype or <html> first), not a snippet. */
export function isHtmlDocumentCodeBlock(language: string | undefined, code: string): boolean {
  return language?.trim().toLowerCase() === 'html' && WHOLE_HTML_DOCUMENT.test(code)
}

/** Splits out each html fence holding a full page; the rest of the text keeps its other fences. */
export function splitHtmlDocumentFences(text: string): { text: string; documents: string[] } {
  const lines = text.split('\n')
  const tracker = createMarkdownFenceTracker()
  const kept: string[] = []
  const documents: string[] = []
  let open: { start: number; language: string; body: string[] } | null = null
  for (const [index, line] of lines.entries()) {
    const wasInside = tracker.insideFence
    const delimiter = tracker.consume(line)
    if (delimiter && !wasInside) {
      open = {
        start: index,
        language: line
          .trim()
          .replace(/^[`~]+/, '')
          .trim(),
        body: []
      }
      continue
    }
    if (open && delimiter && !tracker.insideFence) {
      const code = open.body.join('\n')
      if (isHtmlDocumentCodeBlock(open.language.split(/\s/)[0], code)) {
        documents.push(code)
      } else {
        kept.push(...lines.slice(open.start, index + 1))
      }
      open = null
      continue
    }
    if (open) {
      open.body.push(line)
    } else {
      kept.push(line)
    }
  }
  // An unclosed fence is left as written.
  if (open) {
    kept.push(...lines.slice(open.start))
  }
  return {
    text:
      documents.length > 0
        ? kept
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        : text,
    documents
  }
}
