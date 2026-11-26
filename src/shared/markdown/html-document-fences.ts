import { createMarkdownFenceTracker } from './markdown-fence-scanner'

const WHOLE_HTML_DOCUMENT = /^\s*<(?:!doctype\s+html|html)[\s>]/i
const HTML_FENCE_OPENER = /(?:^|\n) {0,3}(?=`{3}|~{3})[`~]+[^\S\n]*html(?=\s|$)/i

/** A cheap precheck; nested, unclosed and snippet fences can still match. */
export function hasHtmlFenceCandidate(text: string): boolean {
  return HTML_FENCE_OPENER.test(text)
}

/** A fence tagged html whose code is a full page (doctype or <html> first), not a snippet. */
export function isHtmlDocumentCodeBlock(language: string | undefined, code: string): boolean {
  return language?.trim().toLowerCase() === 'html' && WHOLE_HTML_DOCUMENT.test(code)
}

const SEAM = Symbol('removed page')

/** Splits out each html fence holding a full page; the rest of the text is kept as written, with the
 *  blank lines around each removed page folded into one. */
export function splitHtmlDocumentFences(text: string): { text: string; documents: string[] } {
  const lines = text.split('\n')
  const tracker = createMarkdownFenceTracker()
  const kept: (string | typeof SEAM)[] = []
  const documents: string[] = []
  let open: { start: number; language: string; body: string[] } | null = null
  for (const [index, line] of lines.entries()) {
    const bare = line.replace(/\r$/, '')
    const wasInside = tracker.insideFence
    const delimiter = tracker.consume(bare)
    if (delimiter && !wasInside) {
      open = {
        start: index,
        language: bare
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
        kept.push(SEAM)
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
  if (documents.length === 0) {
    return { text, documents }
  }
  const out: string[] = []
  let seam = false
  for (const line of kept) {
    const blank = line === SEAM || !line.trim()
    if (line === SEAM) {
      while (out.length > 0 && !out.at(-1)?.trim()) {
        out.pop()
      }
      seam = true
    } else if (!(seam && blank)) {
      if (seam && out.length > 0) {
        out.push('')
      }
      seam = false
      out.push(line)
    }
  }
  return { text: out.join('\n'), documents }
}
