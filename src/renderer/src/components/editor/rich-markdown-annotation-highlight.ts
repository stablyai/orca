import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

type RichMarkdownAnnotationHighlightState = {
  activeRange: RichMarkdownAnnotationHighlightRange | null
  noteRanges: RichMarkdownAnnotationHighlightRange[]
  decorations: DecorationSet
}

export type RichMarkdownAnnotationHighlightRange = {
  from: number
  to: number
}

type RichMarkdownAnnotationHighlightMeta = {
  activeRange?: RichMarkdownAnnotationHighlightRange | null
  noteRanges?: RichMarkdownAnnotationHighlightRange[]
} | null

export const richMarkdownAnnotationHighlightPluginKey =
  new PluginKey<RichMarkdownAnnotationHighlightState>('richMarkdownAnnotationHighlight')

function createAnnotationDecorations(
  doc: ProseMirrorNode,
  activeRange: RichMarkdownAnnotationHighlightRange | null,
  noteRanges: RichMarkdownAnnotationHighlightRange[]
): DecorationSet {
  const decorations = [
    ...noteRanges.map((range) => ({ range, active: false })),
    ...(activeRange ? [{ range: activeRange, active: true }] : [])
  ]
    .map((range) => {
      const from = Math.min(range.range.from, range.range.to)
      const to = Math.max(range.range.from, range.range.to)
      return from === to
        ? null
        : Decoration.inline(from, to, {
            class: range.active
              ? 'rich-markdown-annotation-selection rich-markdown-annotation-selection-active'
              : 'rich-markdown-annotation-selection'
          })
    })
    .filter((decoration): decoration is Decoration => decoration !== null)
  return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decorations)
}

function createRichMarkdownAnnotationHighlightPlugin(): Plugin<RichMarkdownAnnotationHighlightState> {
  return new Plugin<RichMarkdownAnnotationHighlightState>({
    key: richMarkdownAnnotationHighlightPluginKey,
    state: {
      init: () => ({
        activeRange: null,
        noteRanges: [],
        decorations: DecorationSet.empty
      }),
      apply: (tr, pluginState) => {
        const meta = tr.getMeta(richMarkdownAnnotationHighlightPluginKey) as
          | RichMarkdownAnnotationHighlightMeta
          | undefined
        if (meta === null) {
          return {
            activeRange: null,
            noteRanges: pluginState.noteRanges,
            decorations: createAnnotationDecorations(tr.doc, null, pluginState.noteRanges)
          }
        }
        if (meta) {
          const activeRange =
            meta.activeRange === undefined ? pluginState.activeRange : meta.activeRange
          const noteRanges =
            meta.noteRanges === undefined ? pluginState.noteRanges : meta.noteRanges
          return {
            activeRange,
            noteRanges,
            decorations: createAnnotationDecorations(tr.doc, activeRange, noteRanges)
          }
        }
        if (tr.docChanged) {
          return {
            ...pluginState,
            decorations: pluginState.decorations.map(tr.mapping, tr.doc)
          }
        }
        return pluginState
      }
    },
    props: {
      decorations(state) {
        return (
          richMarkdownAnnotationHighlightPluginKey.getState(state)?.decorations ??
          DecorationSet.empty
        )
      }
    }
  })
}

export function createRichMarkdownAnnotationHighlightExtension(): Extension {
  return Extension.create({
    name: 'richMarkdownAnnotationHighlight',
    addProseMirrorPlugins() {
      return [createRichMarkdownAnnotationHighlightPlugin()]
    }
  })
}
