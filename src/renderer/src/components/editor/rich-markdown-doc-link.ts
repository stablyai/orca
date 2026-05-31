import { Node, mergeAttributes } from '@tiptap/core'
import { type EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { MarkdownDocument } from '../../../../shared/types'
import type { MarkdownDocumentIndex } from './markdown-doc-links'
import {
  createMarkdownDocumentIndex,
  formatMarkdownDocLink,
  parseMarkdownDocLink,
  resolveMarkdownDocLink
} from './markdown-doc-links'
import { isDocLinkLiteralCodeTextNode } from './rich-markdown-doc-link-code-context'

const DOC_LINK_PLACEHOLDER_PREFIX = '[[ORCA_DOC_LINK:'
const DOC_LINK_PLACEHOLDER_SUFFIX = ']]'

// Why: `.matchAll()` at each call site creates a fresh iterator so the shared
// `/g` regex never leaks `lastIndex` state across nested or concurrent scans.
const DOC_LINK_PATTERN = /\[\[([^[\]\r\n]+)\]\]/g

const docLinkDissolveKey = new PluginKey('docLinkDissolve')
const docLinkAutoConvertKey = new PluginKey('docLinkAutoConvert')
const docLinkInlinePreviewKey = new PluginKey('docLinkInlinePreview')

type DocLinkStorage = {
  documents: MarkdownDocument[]
  _cachedDocs: MarkdownDocument[] | null
  _cachedIndex: MarkdownDocumentIndex | null
}

function getDocIndex(storage: DocLinkStorage): MarkdownDocumentIndex | null {
  if (storage.documents.length === 0) {
    // Why: clear the cache so stale MarkdownDocument references aren't retained
    // after the document list empties (e.g., when switching worktrees).
    storage._cachedDocs = null
    storage._cachedIndex = null
    return null
  }
  if (storage._cachedDocs !== storage.documents) {
    storage._cachedIndex = createMarkdownDocumentIndex(storage.documents)
    storage._cachedDocs = storage.documents
  }
  return storage._cachedIndex
}

function buildPreviewDecorations(state: EditorState, storage: DocLinkStorage): DecorationSet {
  const decorations: Decoration[] = []
  const index = getDocIndex(storage)
  const cursor = state.selection.from
  state.doc.descendants((node, pos, parent) => {
    if (node.type.name !== 'text' || !node.text) {
      return
    }
    if (isDocLinkLiteralCodeTextNode(node, parent)) {
      return
    }
    for (const match of node.text.matchAll(DOC_LINK_PATTERN)) {
      const link = parseMarkdownDocLink(match[1])
      if (!link || match.index === undefined) {
        continue
      }
      const from = pos + match.index
      const to = from + match[0].length
      // Why: only decorate the match the cursor is currently editing. Other
      // `[[target]]` matches are auto-converted to atom nodes on the next
      // transaction, so decorating them here just causes a one-frame flicker.
      if (cursor <= from || cursor > to) {
        continue
      }
      const resolved = resolveAgainstIndex(link.target, index)
      const cls = resolved
        ? 'rich-markdown-doc-link-preview'
        : 'rich-markdown-doc-link-preview rich-markdown-doc-link-preview--missing'
      decorations.push(Decoration.inline(from, to, { class: cls }))
    }
  })
  return DecorationSet.create(state.doc, decorations)
}

function resolveAgainstIndex(target: string, index: MarkdownDocumentIndex | null): boolean {
  if (!index) {
    return false
  }
  return resolveMarkdownDocLink(target, index).status === 'resolved'
}

function getDocLinkTarget(node: { attrs: Record<string, unknown> }): string {
  return typeof node.attrs.target === 'string' ? node.attrs.target : ''
}

function getDocLinkAlias(node: { attrs: Record<string, unknown> }): string | null {
  return typeof node.attrs.label === 'string' && node.attrs.label ? node.attrs.label : null
}

function getDocLinkDisplayText(node: { attrs: Record<string, unknown> }): string {
  return getDocLinkAlias(node) ?? getDocLinkTarget(node)
}

export const MarkdownDocLink = Node.create({
  name: 'markdownDocLink',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addStorage() {
    return {
      documents: [] as MarkdownDocument[],
      _cachedDocs: null as MarkdownDocument[] | null,
      _cachedIndex: null as MarkdownDocumentIndex | null
    }
  },

  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-doc-link-target') ?? ''
      },
      label: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-doc-link-label')
      }
    }
  },

  markdownTokenName: 'markdownDocLink',
  markdownTokenizer: {
    name: 'markdownDocLink',
    level: 'inline',
    start: DOC_LINK_PLACEHOLDER_PREFIX,
    tokenize(src: string) {
      if (!src.startsWith(DOC_LINK_PLACEHOLDER_PREFIX)) {
        return undefined
      }

      const endIndex = src.indexOf(DOC_LINK_PLACEHOLDER_SUFFIX, DOC_LINK_PLACEHOLDER_PREFIX.length)
      if (endIndex === -1) {
        return undefined
      }

      const placeholder = src.slice(0, endIndex + DOC_LINK_PLACEHOLDER_SUFFIX.length)
      const link = parseMarkdownDocLink(src.slice(DOC_LINK_PLACEHOLDER_PREFIX.length, endIndex))
      if (!link) {
        return undefined
      }

      return {
        type: 'markdownDocLink',
        raw: placeholder,
        text: link.target,
        label: link.alias ?? undefined
      }
    }
  },

  parseMarkdown: (token, helpers) => {
    if (token.type !== 'markdownDocLink') {
      return []
    }
    return helpers.createNode('markdownDocLink', {
      target: typeof token.text === 'string' ? token.text : '',
      label:
        typeof (token as { label?: unknown }).label === 'string'
          ? (token as { label: string }).label
          : null
    })
  },

  renderMarkdown: (node) =>
    formatMarkdownDocLink(
      typeof node.attrs?.target === 'string' ? node.attrs.target : '',
      typeof node.attrs?.label === 'string' ? node.attrs.label : null
    ),

  addNodeView() {
    const storage = this.storage as DocLinkStorage
    return ({ node }: { node: { type: { name: string }; attrs: Record<string, unknown> } }) => {
      const target = getDocLinkTarget(node)
      const dom = document.createElement('span')
      dom.setAttribute('data-doc-link-target', target)
      const alias = getDocLinkAlias(node)
      if (alias) {
        dom.setAttribute('data-doc-link-label', alias)
      }
      dom.setAttribute('contenteditable', 'false')
      dom.textContent = getDocLinkDisplayText(node)

      const applyResolutionClass = (t: string): void => {
        const resolved = resolveAgainstIndex(t, getDocIndex(storage))
        dom.className = resolved
          ? 'rich-markdown-doc-link'
          : 'rich-markdown-doc-link rich-markdown-doc-link--missing'
      }

      applyResolutionClass(target)

      return {
        dom,
        // Why: this fires on every transaction, including the no-op dispatched
        // when the document list changes in storage. Re-checking resolution
        // here keeps the blue/grey styling current without a full re-render.
        update: (updatedNode: { type: { name: string }; attrs: Record<string, unknown> }) => {
          if (updatedNode.type.name !== 'markdownDocLink') {
            return false
          }
          const newTarget = getDocLinkTarget(updatedNode)
          const newAlias = getDocLinkAlias(updatedNode)
          dom.setAttribute('data-doc-link-target', newTarget)
          if (newAlias) {
            dom.setAttribute('data-doc-link-label', newAlias)
          } else {
            dom.removeAttribute('data-doc-link-label')
          }
          dom.textContent = getDocLinkDisplayText(updatedNode)
          applyResolutionClass(newTarget)
          return true
        }
      }
    }
  },

  // Why: a ProseMirror plugin (not an input rule) so that [[target]] typed in
  // any order — brackets first then target, paste, etc. — converts to a doc
  // link node. Input rules only fire on sequential append at the cursor.
  addProseMirrorPlugins() {
    const nodeType = this.type
    const storage = this.storage as DocLinkStorage
    return [
      // Why: when the cursor is adjacent to a doc link atom and the user presses
      // an arrow key toward it, dissolve the atom back to editable [[target]] text.
      // Without this, atom nodes are un-enterable — the cursor jumps over them.
      // Uses handleKeyDown (not addKeyboardShortcuts) so we can check modifier
      // keys and let Shift+Arrow extend the selection normally.
      new Plugin({
        key: docLinkDissolveKey,
        props: {
          handleKeyDown(view, event) {
            if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
              return false
            }
            let direction: 'left' | 'right'
            if (event.key === 'ArrowLeft') {
              direction = 'left'
            } else if (event.key === 'ArrowRight') {
              direction = 'right'
            } else {
              return false
            }
            const { state } = view
            if (!(state.selection instanceof TextSelection)) {
              return false
            }
            const { $from } = state.selection
            const adjacent = direction === 'left' ? $from.nodeBefore : $from.nodeAfter
            if (!adjacent || adjacent.type.name !== 'markdownDocLink') {
              return false
            }
            const target = getDocLinkTarget(adjacent)
            const text = formatMarkdownDocLink(target, getDocLinkAlias(adjacent))
            const nodeStart = direction === 'left' ? $from.pos - adjacent.nodeSize : $from.pos
            const nodeEnd = nodeStart + adjacent.nodeSize
            const tr = state.tr.replaceWith(nodeStart, nodeEnd, state.schema.text(text))
            const cursorPos = direction === 'left' ? nodeStart + text.length - 2 : nodeStart + 2
            tr.setSelection(TextSelection.create(tr.doc, cursorPos))
            view.dispatch(tr)
            return true
          }
        }
      }),

      new Plugin({
        key: docLinkAutoConvertKey,
        appendTransaction(_transactions, _oldState, newState) {
          const { tr } = newState
          const cursor = newState.selection.from
          let modified = false

          newState.doc.descendants((node, pos, parent) => {
            if (node.type.name !== 'text' || !node.text) {
              return
            }
            if (isDocLinkLiteralCodeTextNode(node, parent)) {
              return
            }

            for (const match of node.text.matchAll(DOC_LINK_PATTERN)) {
              const link = parseMarkdownDocLink(match[1])
              if (!link || match.index === undefined) {
                continue
              }

              const from = pos + match.index
              const to = from + match[0].length

              // Why: skip when the cursor is anywhere from just inside [[
              // through the closing ]]. The inline preview decoration gives
              // real-time resolution feedback while the user is still editing.
              if (cursor > from && cursor <= to) {
                continue
              }

              const docLinkNode = nodeType.create({ target: link.target, label: link.alias })
              tr.replaceWith(tr.mapping.map(from), tr.mapping.map(to), docLinkNode)
              modified = true
            }
          })

          return modified ? tr : null
        }
      }),

      // Why: while the cursor is inside [[target]], the text hasn't converted
      // to an atom node yet. This decoration gives real-time blue/grey feedback
      // so the user knows whether the target resolves before moving the cursor out.
      new Plugin({
        key: docLinkInlinePreviewKey,
        state: {
          init(_, state) {
            return buildPreviewDecorations(state, storage)
          },
          apply(tr, prev, oldState, newState) {
            const selectionMoved = !oldState.selection.eq(newState.selection)
            if (!tr.docChanged && !selectionMoved && !tr.getMeta('docLinksUpdated')) {
              return prev
            }
            return buildPreviewDecorations(newState, storage)
          }
        },
        props: {
          decorations(state) {
            return docLinkInlinePreviewKey.getState(state)
          }
        }
      })
    ]
  },

  parseHTML() {
    return [{ tag: 'span[data-doc-link-target]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const target = typeof node.attrs.target === 'string' ? node.attrs.target : ''
    const label = typeof node.attrs.label === 'string' ? node.attrs.label : null
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-doc-link-target': target,
        ...(label ? { 'data-doc-link-label': label } : {}),
        contenteditable: 'false',
        class: 'rich-markdown-doc-link'
      }),
      label ?? target
    ]
  }
})
