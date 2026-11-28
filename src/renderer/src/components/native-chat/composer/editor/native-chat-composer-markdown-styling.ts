import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  classifyNativeChatMarkdown,
  type NativeChatMarkdownBlock,
  type NativeChatMarkdownSpanKind
} from './native-chat-composer-markdown-syntax'
import './native-chat-composer-markdown.css'

// Why: a pasted log must not make every keystroke restyle thousands of lines.
const MAX_STYLED_SIZE = 30_000
const PILL = '\uFFFC'

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
  // A pill is one placeholder character, so it is never syntax and spans keep their document offsets.
  const lines = paragraphs.map(({ node }) => node.textBetween(0, node.content.size, '', PILL))
  const classified = classifyNativeChatMarkdown(lines)
  const decorations: Decoration[] = []
  paragraphs.forEach(({ node, pos }, index) => {
    const { block, spans } = classified[index]
    const className = blockClass(block)
    if (className) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: className }))
    }
    for (const span of spans) {
      if (span.to > span.from) {
        decorations.push(
          Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, {
            class: SPAN_CLASS[span.kind]
          })
        )
      }
    }
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
