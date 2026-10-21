import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { reconcileSerializedMarkdown } from './rich-markdown-source-reconcile'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function canonical(markdown: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(markdown, codec),
    contentType: 'markdown'
  })
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

/** A tracked action document shaped like the one issue 16469 reports on. */
function buildTrackingDocument(targetCodeUnits: number): string {
  const parts: string[] = []
  let section = 0
  while (parts.join('\n').length < targetCodeUnits) {
    section += 1
    parts.push(`## Section ${section}`)
    parts.push('')
    parts.push(`Finance > Invoices for section ${section}, covering F&B spend and a < b && c.`)
    parts.push('')
    parts.push(`9. Single digit item for section ${section}`)
    parts.push('   with a continuation line that must stay inside the item.')
    parts.push(`10. Two digit item for section ${section}`)
    parts.push('    with its own continuation line that must also stay put.')
    parts.push('')
    parts.push(`Reference **\`B9393${section}\`** and Veri\\*Factu at R$ 40,000.`)
    parts.push('')
    parts.push(
      `Longer prose for section ${section} so the document reaches a realistic size, recording commitments made to external partners and the follow-up owed on each of them before the next review.`
    )
    parts.push('')
  }
  return parts.join('\n')
}

describe('reconcile size cap', () => {
  it('keeps a document the size of the reported one on the reconcile path', () => {
    const source = buildTrackingDocument(60_000)
    expect(source.length).toBeGreaterThan(50_000)

    const base = canonical(source)
    const edited = canonical(`${source}\n\nA trailing paragraph the user just typed.`)
    const reconciled = reconcileSerializedMarkdown({
      originalSource: source,
      baseCanonical: base,
      edited,
      roundTrip: canonical
    })

    expect(reconciled.startsWith(source)).toBe(true)
    expect(reconciled).toContain('A trailing paragraph the user just typed.')
  })

  it('round-trips every fixed construct in a document of that size', () => {
    const source = buildTrackingDocument(60_000)
    expect(canonical(source).trimEnd()).toBe(source.trimEnd())
  })
})
