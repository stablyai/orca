import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  classifyNativeChatMarkdown,
  nativeChatMarkdownInlineSpans,
  type NativeChatMarkdownBlock,
  type NativeChatMarkdownSpanKind
} from './native-chat-composer-markdown-syntax'
import './native-chat-composer-markdown.css'

// Why: a pasted log must not make every keystroke restyle thousands of lines.
const MAX_STYLED_SIZE = 30_000

const SPAN_CLASS: Record<NativeChatMarkdownSpanKind, string> = {
  marker: 'native-chat-md-marker',
  'bullet-marker': 'native-chat-md-list-marker',
  bold: 'native-chat-md-bold',
  italic: 'native-chat-md-italic',
  strike: 'native-chat-md-strike',
  code: 'native-chat-md-code'
}

const BLOCK_CLASS: Record<Exclude<NativeChatMarkdownBlock['kind'], 'text' | 'heading'>, string> = {
  quote: 'native-chat-md-quote',
  bullet: 'native-chat-md-bullet',
  ordered: 'native-chat-md-ordered',
  rule: 'native-chat-md-rule',
  fence: 'native-chat-md-fence',
  code: 'native-chat-md-code-line'
}

function blockClass(block: NativeChatMarkdownBlock): string | null {
  if (block.kind === 'text') {
    return null
  }
  return block.kind === 'heading'
    ? `native-chat-md-heading native-chat-md-h${block.level}`
    : BLOCK_CLASS[block.kind]
}

/** Styles the markdown a draft already contains; the text is unchanged, so what is sent is too. */
function styleDraft(doc: ProseMirrorNode): DecorationSet {
  if (doc.content.size > MAX_STYLED_SIZE) {
    return DecorationSet.empty
  }
  const paragraphs: { node: ProseMirrorNode; pos: number }[] = []
  doc.forEach((node, offset) => {
    if (node.isTextblock) {
      paragraphs.push({ node, pos: offset })
    }
  })
  // A pill or other inline node is not text: only a line that starts with text can open a block.
  const lines = paragraphs.map(
    ({ node }) => (node.firstChild?.isText ? node.firstChild.text : '') ?? ''
  )
  const classified = classifyNativeChatMarkdown(lines)
  const decorations: Decoration[] = []
  paragraphs.forEach(({ node, pos }, index) => {
    const { block, spans } = classified[index]
    const className = blockClass(block)
    if (className) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: className }))
    }
    // A pill is not text and splits the line: text after one is styled for inline syntax only.
    let offset = pos + 1
    node.forEach((part, _, childIndex) => {
      if (part.isText && part.text) {
        const partSpans = childIndex === 0 ? spans : nativeChatMarkdownInlineSpans(part.text)
        for (const span of partSpans) {
          if (span.to > span.from) {
            decorations.push(
              Decoration.inline(offset + span.from, offset + span.to, {
                class: SPAN_CLASS[span.kind]
              })
            )
          }
        }
      }
      offset += part.nodeSize
    })
  })
  return DecorationSet.create(doc, decorations)
}

const key = new PluginKey<DecorationSet>('nativeChatComposerMarkdownStyling')

// Why: restyling mid-composition re-renders the IME's text node; restyle once it ends.
function requestRestyle(view: EditorView): void {
  setTimeout(() => {
    if (!view.isDestroyed && !view.composing) {
      view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false))
    }
  })
}

export const NativeChatComposerMarkdownStyling = Extension.create({
  name: 'nativeChatComposerMarkdownStyling',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => styleDraft(state.doc),
          apply: (tr, previous) => {
            if (!tr.docChanged && tr.getMeta(key) !== true) {
              return previous
            }
            if (tr.getMeta('composition') !== undefined) {
              return previous.map(tr.mapping, tr.doc)
            }
            return styleDraft(tr.doc)
          }
        },
        props: {
          decorations: (state) => key.getState(state),
          handleDOMEvents: {
            compositionend: (view) => {
              requestRestyle(view)
              return false
            }
          }
        }
      })
    ]
  }
})
