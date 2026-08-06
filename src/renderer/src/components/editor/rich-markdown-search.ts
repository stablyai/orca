import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  findTextMatchRanges,
  isMarkdownPreviewSearchQueryTooLarge,
  type TextMatchOptions
} from './markdown-preview-search'
import {
  createRichMarkdownVisibleTextMap,
  type RichMarkdownVisibleTextSegment
} from './rich-markdown-visible-text-map'

export type RichMarkdownSearchMatch = {
  from: number
  to: number
  touchesReadOnlyAtom?: boolean
  decorationRanges?: { from: number; to: number; kind: 'inline' | 'node' }[]
}

export type RichMarkdownSearchStats = { segmentVisits: number }

type RichMarkdownSearchState = {
  activeIndex: number
  decorations: DecorationSet
  query: string
}

type RichMarkdownSearchMeta = {
  activeIndex: number
  matches: RichMarkdownSearchMatch[]
  query: string
}

export const richMarkdownSearchPluginKey = new PluginKey<RichMarkdownSearchState>(
  'richMarkdownSearch'
)

export function findRichMarkdownSearchMatches(
  doc: ProseMirrorNode,
  query: string,
  options?: TextMatchOptions,
  stats?: RichMarkdownSearchStats
): RichMarkdownSearchMatch[] {
  if (!query) {
    return []
  }
  if (isMarkdownPreviewSearchQueryTooLarge(query)) {
    return []
  }

  const matches: RichMarkdownSearchMatch[] = []
  const visibleMap = createRichMarkdownVisibleTextMap(doc)
  const ranges = findTextMatchRanges(visibleMap.text, query, options)
  let segmentIndex = 0
  for (const range of ranges) {
    while (
      segmentIndex < visibleMap.segments.length &&
      visibleMap.segments[segmentIndex]!.visibleTo <= range.start
    ) {
      if (stats) {
        stats.segmentVisits += 1
      }
      segmentIndex += 1
    }
    const firstSegmentIndex = segmentIndex
    let lastSegmentIndex = firstSegmentIndex - 1
    let touchesReadOnlyAtom = false
    let segmentsAreContiguous = true
    let touchesSeparator = false
    while (
      lastSegmentIndex + 1 < visibleMap.segments.length &&
      visibleMap.segments[lastSegmentIndex + 1]!.visibleFrom < range.end
    ) {
      lastSegmentIndex += 1
      if (stats) {
        stats.segmentVisits += 1
      }
      touchesReadOnlyAtom ||= visibleMap.segments[lastSegmentIndex]!.kind === 'read-only-atom'
      touchesSeparator ||= visibleMap.segments[lastSegmentIndex]!.kind === 'separator'
      const previous = visibleMap.segments[lastSegmentIndex - 1]
      const current = visibleMap.segments[lastSegmentIndex]!
      if (lastSegmentIndex > firstSegmentIndex && previous?.to !== current.from) {
        segmentsAreContiguous = false
      }
    }
    const first = visibleMap.segments[firstSegmentIndex]
    const last = visibleMap.segments[lastSegmentIndex]
    if (!first || !last || !segmentsAreContiguous || touchesSeparator) {
      continue
    }
    const from = mapSegmentStart(first, range.start)
    const to = mapSegmentEnd(last, range.end)
    matches.push(
      touchesReadOnlyAtom
        ? {
            from,
            to,
            touchesReadOnlyAtom: true,
            decorationRanges: visibleMap.segments
              .slice(firstSegmentIndex, lastSegmentIndex + 1)
              .map((segment) => ({
                from: mapSegmentStart(segment, range.start),
                to: mapSegmentEnd(segment, range.end),
                kind: segment.kind === 'text' ? ('inline' as const) : ('node' as const)
              }))
          }
        : { from, to }
    )
  }

  return matches
}

function mapSegmentStart(segment: RichMarkdownVisibleTextSegment, visibleFrom: number): number {
  return segment.kind === 'text'
    ? segment.from + Math.max(0, visibleFrom - segment.visibleFrom)
    : segment.from
}

function mapSegmentEnd(segment: RichMarkdownVisibleTextSegment, visibleTo: number): number {
  return segment.kind === 'text'
    ? segment.from + Math.min(segment.text.length, visibleTo - segment.visibleFrom)
    : segment.to
}

export function createRichMarkdownSearchPlugin(): Plugin<RichMarkdownSearchState> {
  return new Plugin<RichMarkdownSearchState>({
    key: richMarkdownSearchPluginKey,
    state: {
      init: () => ({
        activeIndex: -1,
        decorations: DecorationSet.empty,
        query: ''
      }),
      apply: (tr, pluginState) => {
        const meta = tr.getMeta(richMarkdownSearchPluginKey) as RichMarkdownSearchMeta | undefined
        const query = meta?.query ?? pluginState.query
        const activeIndex = meta?.activeIndex ?? pluginState.activeIndex

        if (!query) {
          return {
            activeIndex: -1,
            decorations: DecorationSet.empty,
            query: ''
          }
        }

        // Why: when meta carries pre-computed matches from the React layer,
        // build decorations directly without re-walking the document. When the
        // doc changes without new meta (user edits while searching), remap
        // existing decorations until the React layer recomputes and dispatches
        // fresh matches. This avoids the old double-walk that froze the UI.
        if (meta) {
          return {
            activeIndex,
            decorations: buildSearchDecorationsFromMatches(tr.doc, meta.matches, activeIndex),
            query
          }
        }

        if (tr.docChanged) {
          return {
            activeIndex: pluginState.activeIndex,
            decorations: pluginState.decorations.map(tr.mapping, tr.doc),
            query: pluginState.query
          }
        }

        return pluginState
      }
    },
    props: {
      decorations(state) {
        return richMarkdownSearchPluginKey.getState(state)?.decorations ?? DecorationSet.empty
      }
    }
  })
}

function buildSearchDecorationsFromMatches(
  doc: ProseMirrorNode,
  matches: RichMarkdownSearchMatch[],
  activeIndex: number
): DecorationSet {
  if (matches.length === 0) {
    return DecorationSet.empty
  }

  const decorations = matches.flatMap((match, index) =>
    (match.decorationRanges ?? [{ from: match.from, to: match.to, kind: 'inline' as const }]).map(
      (range) => {
        const attrs = {
          class: 'rich-markdown-search-match',
          'data-active': index === activeIndex ? 'true' : undefined
        }
        return range.kind === 'node'
          ? Decoration.node(range.from, range.to, attrs)
          : Decoration.inline(range.from, range.to, attrs)
      }
    )
  )

  return DecorationSet.create(doc, decorations)
}
