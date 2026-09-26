import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

/** The reproduction document from issue 16469, verbatim. */
const REPRODUCTION = [
  '# Orca markdown corruption repro',
  '',
  '## 1. Bare angle bracket and ampersand',
  '',
  'Automate the Finance > Invoices download.',
  '',
  'Never validated by the F&B team.',
  '',
  '## 2. Backslash-escaped asterisk',
  '',
  'Veri\\*Factu is a deliverable.',
  '',
  '## 3. Space inside a currency figure',
  '',
  'The link commits R$ 40,000 on acceptance.',
  '',
  '## 4. Bold wrapping a code span',
  '',
  'The provisional NIF is **`B93934206`**.',
  '',
  '## 5. Code span followed by a word',
  '',
  'Read `Anexo v2.docx` and write up the procedure.',
  '',
  '## 6. Ordered list with two-digit markers and wrapped continuations',
  '',
  '9. **Single digit item.** This continuation line is indented three spaces',
  '   and must stay inside item 9.',
  '10. **Two digit item.** This continuation line is indented four spaces',
  '    and must stay inside item 10.',
  '',
  '## 7. Task list',
  '',
  '- [ ] An item that is not done.',
  '- [ ] Another item that is not done.'
].join('\n')

function roundTrip(source: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

describe('issue 16469 reproduction document', () => {
  it('comes back byte-identical', () => {
    expect(roundTrip(REPRODUCTION)).toBe(REPRODUCTION)
  })

  it('stays byte-identical across three cycles', () => {
    let current = REPRODUCTION
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(REPRODUCTION)
  })

  it.each([
    ['entity escaping', 'Finance > Invoices'],
    ['bare ampersand', 'F&B team'],
    ['backslash escape', 'Veri\\*Factu'],
    ['currency figure', 'R$ 40,000'],
    ['bold around a code span', '**`B93934206`**'],
    ['code span followed by a word', '`Anexo v2.docx` and'],
    ['single digit continuation', '\n   and must stay inside item 9.'],
    ['two digit continuation', '\n    and must stay inside item 10.']
  ])('preserves the %s case', (_name, fragment) => {
    expect(roundTrip(REPRODUCTION)).toContain(fragment)
  })

  it('leaves every task checkbox unchecked', () => {
    expect(roundTrip(REPRODUCTION)).not.toContain('- [x]')
  })
})
