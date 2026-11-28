import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Editor } from '@tiptap/react'
import { SIDE_CHAT_NODE } from './native-chat-side-chat-node'

declare module '@tiptap/core' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Tiptap Storage requires declaration merging.
  interface Storage {
    nativeChatClaudeKeywords?: { enabled: boolean }
  }
}

export type ClaudeKeyword = { word: string; start: number; end: number; rainbow: boolean }

// Claude Code's terminal colors these as typed: two in rainbow, `ultracode` in its effort purple.
const RAINBOW_WORDS = ['ultrathink', 'ultraplan']
const RAINBOW = [
  'var(--destructive)',
  'color-mix(in srgb, var(--destructive) 50%, var(--status-warning))',
  'var(--status-warning)',
  'var(--status-success)',
  'var(--callout-note)',
  'color-mix(in srgb, var(--callout-note) 50%, var(--callout-important))',
  'var(--callout-important)'
]
const ULTRACODE_COLOR = 'var(--callout-important)'
const KEYWORD = /\b(ultrathink|ultraplan|ultracode)\b/gi
const QUOTE_CLOSERS: Record<string, string> = {
  '`': '`',
  '"': '"',
  '<': '>',
  '{': '}',
  '[': ']',
  '(': ')',
  "'": "'"
}
const isWordChar = (char: string | undefined): boolean => !!char && /[\p{L}\p{N}_]/u.test(char)

// Text the user quoted, bracketed or tagged names the word instead of asking for it.
function quotedSpans(text: string): [number, number][] {
  const spans: [number, number][] = []
  let open: string | null = null
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (open) {
      if (open === '[' && char === '[') {
        start = index
      } else if (char === QUOTE_CLOSERS[open] && !(open === "'" && isWordChar(text[index + 1]))) {
        spans.push([start, index + 1])
        open = null
      }
    } else if (
      (char === '<' && /[a-zA-Z/]/.test(text[index + 1] ?? '')) ||
      (char === "'" && !isWordChar(text[index - 1])) ||
      (char !== '<' && char !== "'" && char in QUOTE_CLOSERS)
    ) {
      open = char
      start = index
    }
  }
  return spans
}

/** The keywords Claude Code colors in `text`: not inside quotes, brackets or a tag, not part of a
 *  path, flag or file name, and none at all in a slash command. */
export function claudeKeywords(text: string): ClaudeKeyword[] {
  return text.startsWith('/') ? [] : keywordsIn(text)
}

function keywordsIn(text: string): ClaudeKeyword[] {
  if (!/ultra/i.test(text)) {
    return []
  }
  const spans = quotedSpans(text)
  const found: ClaudeKeyword[] = []
  for (const match of text.matchAll(KEYWORD)) {
    const start = match.index
    const end = start + match[0].length
    const before = text[start - 1]
    const after = text[end]
    if (
      spans.some(([from, to]) => start >= from && start < to) ||
      before === '/' ||
      before === '\\' ||
      before === '-' ||
      after === '/' ||
      after === '\\' ||
      after === '-' ||
      after === '?' ||
      (after === '.' && isWordChar(text[end + 1]))
    ) {
      continue
    }
    const word = match[0]
    found.push({ word, start, end, rainbow: RAINBOW_WORDS.includes(word.toLowerCase()) })
  }
  return found
}

// The prompt as Claude reads it, with each character's document position: a side-chat pill reads
// as its `/btw ` command, a hard break as `\n`, other pills as one placeholder, paragraphs joined by `\n`.
function promptCharacters(doc: ProseMirrorNode): { text: string; positions: number[] } {
  let text = ''
  const positions: number[] = []
  let textblocks = 0
  doc.descendants((node, pos) => {
    // Why: promptText puts a newline before every textblock but the first, empty ones included.
    if (node.isTextblock && textblocks++ > 0) {
      text += '\n'
      positions.push(-1)
    }
    if (node.isText) {
      text += node.text ?? ''
      for (let index = 0; index < (node.text ?? '').length; index++) {
        positions.push(pos + index)
      }
    } else if (node.isLeaf) {
      const leaf =
        node.type.name === SIDE_CHAT_NODE
          ? String(node.attrs.token ?? '')
          : node.type.name === 'hardBreak'
            ? '\n'
            : '\ufffc'
      text += leaf
      positions.push(...Array.from(leaf, () => pos))
    }
    return true
  })
  return { text, positions }
}

function keywordDecorations(doc: ProseMirrorNode): DecorationSet {
  const { text, positions } = promptCharacters(doc)
  const decorations: Decoration[] = []
  for (const keyword of claudeKeywords(text)) {
    const from = positions[keyword.start]
    if (!keyword.rainbow) {
      decorations.push(
        Decoration.inline(from, from + keyword.end - keyword.start, {
          'data-claude-keyword': '',
          style: `color: ${ULTRACODE_COLOR}`
        })
      )
      continue
    }
    for (let letter = 0; letter < keyword.end - keyword.start; letter++) {
      decorations.push(
        Decoration.inline(from + letter, from + letter + 1, {
          'data-claude-keyword': '',
          style: `color: ${RAINBOW[letter % RAINBOW.length]}`
        })
      )
    }
  }
  return DecorationSet.create(doc, decorations)
}

const key = new PluginKey<DecorationSet>('nativeChatClaudeKeywords')

const redecorate = (view: EditorView): void =>
  view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false))

/** Turns the coloring on for a Claude chat; other agents don't read these words. */
export function syncClaudeKeywords(editor: Editor | null, enabled: boolean): void {
  // A destroyed editor has no storage; one not mounted yet reads as destroyed but takes transactions.
  const storage = editor?.storage.nativeChatClaudeKeywords
  if (!editor || !storage || storage.enabled === enabled) {
    return
  }
  storage.enabled = enabled
  redecorate(editor.view)
}

/** Colors `ultrathink`, `ultraplan` and `ultracode` the way Claude Code's own prompt does. */
export const NativeChatClaudeKeywords = Extension.create<object, { enabled: boolean }>({
  name: 'nativeChatClaudeKeywords',
  addStorage: () => ({ enabled: false }),
  addProseMirrorPlugins() {
    const storage = this.storage
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, previous) => {
            if (!tr.docChanged && tr.getMeta(key) !== true) {
              return previous
            }
            // Why: redecorating mid-composition re-renders the IME's text node.
            if (tr.getMeta('composition') !== undefined) {
              return previous.map(tr.mapping, tr.doc)
            }
            return storage.enabled ? keywordDecorations(tr.doc) : DecorationSet.empty
          }
        },
        props: {
          decorations: (state) => key.getState(state),
          handleDOMEvents: {
            // A composition can end with no further doc change; color what it typed.
            compositionend: (view) => {
              setTimeout(() => !view.isDestroyed && !view.composing && redecorate(view))
              return false
            }
          }
        }
      })
    ]
  }
})
