import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'

function withoutOptionalEscapes(markdown: string): string {
  return markdown.replace(/\\([\\_[\]])/g, (escaped, character) =>
    character === '\\' ? escaped : character
  )
}

export function preserveLiteralMarkdownSource(
  editor: Editor,
  codec: RichMarkdownEditorCodec,
  htmlSuperscriptLinks: boolean
): void {
  const manager = editor.markdown!
  const render = manager.renderNodeToMarkdown.bind(manager)
  const serialize = editor.getMarkdown.bind(editor)
  const cache = new WeakMap<ProseMirrorNode, { markdown: string; result: string }>()
  let blocks: Map<JSONContent, ProseMirrorNode> | undefined

  manager.renderNodeToMarkdown = (node, ...args) => {
    const markdown = render(node, ...args)
    const block = blocks?.get(node)
    if (!block || !/\\[[\]]/.test(markdown)) {
      return markdown
    }
    const cached = cache.get(block)
    if (cached?.markdown === markdown) {
      return cached.result
    }
    const candidate = withoutOptionalEscapes(markdown)
    let result = markdown
    try {
      const parsed = manager.parse(
        encodeRawMarkdownHtmlForRichEditor(candidate, codec, { htmlSuperscriptLinks })
      )
      // Every mark, attribute and text position must survive reopening this block.
      if (parsed.content?.length === 1 && editor.schema.nodeFromJSON(parsed.content[0]).eq(block)) {
        result = candidate
      }
    } catch {
      // Keep the upstream escaped output when a custom parser cannot prove equivalence.
    }
    cache.set(block, { markdown, result })
    return result
  }

  editor.getMarkdown = () => {
    const markdown = serialize()
    if (!/\\[[\]]/.test(markdown)) {
      return markdown
    }
    // Reference definitions can change inline meaning across block boundaries.
    if (/^ {0,3}\[[^\n]*\]:/m.test(withoutOptionalEscapes(markdown))) {
      return markdown
    }
    const json = editor.getJSON()
    blocks = new Map()
    json.content?.forEach((node, index) => {
      if (node.type === 'paragraph' || node.type === 'heading') {
        blocks!.set(node, editor.state.doc.child(index))
      }
    })
    try {
      return manager.serialize(json)
    } finally {
      blocks = undefined
    }
  }
}
