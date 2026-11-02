import { combineTransactionSteps, getChangedRanges, mergeAttributes } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import type { EditorState } from '@tiptap/pm/state'
import { findProseUrlEnd, splitAtProseUrlTerminators } from '../../../../shared/prose-url-boundary'

const MAX_AUTOLINK_PASSES = 8

function isFileUri(href: unknown): href is string {
  return typeof href === 'string' && /^file:/i.test(href.trim())
}

// Linkify's scanner rejects U+30FB (katakana middle dot) inside URL paths while accepting U+00B7
// (middle dot). Both are 1 UTF-16 code unit, so swapping before linkify preserves match offsets.
function normalizeCjkLinkifySegment(segment: string): string {
  return segment.replaceAll('・', '·')
}

function normalizeTextForLinkify(text: string): string {
  return splitAtProseUrlTerminators(text)
    .map((piece, index) =>
      index % 2 === 1 ? ' '.repeat(piece.length) : normalizeCjkLinkifySegment(piece)
    )
    .join('')
}

function restoreLinkText(
  rawHref: unknown,
  matchedText: string,
  originalText: string
): string | undefined {
  if (typeof rawHref !== 'string') {
    return undefined
  }
  return rawHref.endsWith(matchedText)
    ? `${rawHref.slice(0, rawHref.length - matchedText.length)}${originalText}`
    : rawHref
}

function createLinkifyAwareState(
  newState: EditorState,
  sharedTr: EditorState['tr'],
  rangeBoundaries: ReadonlyMap<number, readonly number[]>,
  passIndex: number
): EditorState {
  const doc = Object.create(newState.doc, {
    textBetween: {
      value: (from: number, to: number, blockSeparator?: string, leafText?: string) => {
        const boundaries = rangeBoundaries.get(to)
        if (boundaries) {
          const boundaryTo = boundaries[passIndex]
          if (boundaryTo === undefined) {
            return ''
          }
          return normalizeTextForLinkify(
            newState.doc.textBetween(from, boundaryTo, blockSeparator, leafText)
          )
        }
        return normalizeTextForLinkify(newState.doc.textBetween(from, to, blockSeparator, leafText))
      }
    }
  })
  return Object.create(newState, {
    doc: { value: doc },
    tr: { value: sharedTr }
  })
}

// Why: Tiptap blanks file: hrefs in clipboard HTML, so copy/paste dropped those links. Admitting
// them only in HTML transfer keeps autolink and plain-URL paste rules ignoring bare file: text.
export const RichMarkdownLink = Link.extend({
  addOptions() {
    const parentOptions = this.parent?.()
    if (!parentOptions) {
      return parentOptions
    }
    const parentShouldAutoLink = parentOptions.shouldAutoLink
    return {
      ...parentOptions,
      shouldAutoLink: (url) =>
        findProseUrlEnd(url) === -1 && (parentShouldAutoLink ? parentShouldAutoLink(url) : true)
    }
  },
  parseHTML() {
    return [
      {
        tag: 'a[href]',
        getAttrs: (dom) => (isFileUri(dom.getAttribute('href')) ? null : false)
      },
      ...(this.parent?.() ?? [])
    ]
  },
  renderHTML({ HTMLAttributes, mark }) {
    if (isFileUri(HTMLAttributes.href)) {
      return ['a', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
    }
    return this.parent?.({ HTMLAttributes, mark }) ?? ['a', HTMLAttributes, 0]
  },
  addPasteRules() {
    return (this.parent?.() ?? []).map((rule) => {
      const find = rule.find
      if (typeof find !== 'function') {
        return rule
      }
      rule.find = (text, event) => {
        const matches: NonNullable<ReturnType<typeof find>> = []
        let offset = 0
        for (const [index, piece] of splitAtProseUrlTerminators(text).entries()) {
          if (index % 2 === 0 && piece.length > 0) {
            for (const match of find(normalizeCjkLinkifySegment(piece), event) ?? []) {
              const originalText = piece.slice(match.index, match.index + match.text.length)
              const href = restoreLinkText(match.data?.href, match.text, originalText)
              matches.push({
                ...match,
                index: match.index + offset,
                text: originalText,
                ...(href === undefined ? {} : { data: { ...match.data, href } })
              })
            }
          }
          offset += piece.length
        }
        return matches
      }
      return rule
    })
  },
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? []
    for (const plugin of plugins) {
      const parentAppendTransaction = plugin.spec.appendTransaction
      if (!parentAppendTransaction) {
        continue
      }
      plugin.spec.appendTransaction = (transactions, oldState, newState) => {
        const docChanges =
          transactions.some((transaction) => transaction.docChanged) &&
          !oldState.doc.eq(newState.doc)
        const preventAutolink = transactions.some((transaction) =>
          transaction.getMeta('preventAutolink')
        )
        if (!docChanges || preventAutolink) {
          return undefined
        }

        const transform = combineTransactionSteps(oldState.doc, [...transactions])
        const rangeBoundaries = new Map<number, number[]>()
        let maxPasses = 1
        for (const { newRange } of getChangedRanges(transform)) {
          if (!newState.doc.resolve(newRange.from).sameParent(newState.doc.resolve(newRange.to))) {
            continue
          }
          const normalizedRange = normalizeTextForLinkify(
            newState.doc.textBetween(newRange.from, newRange.to, ' ', ' ')
          )
          const boundaries: number[] = []
          let segmentStart = 0
          for (const match of normalizedRange.matchAll(/\s+/g)) {
            if (match.index === undefined) {
              continue
            }
            const segment = normalizedRange.slice(segmentStart, match.index)
            if (segmentStart === 0 || /[.:]/.test(segment)) {
              boundaries.push(newRange.from + match.index + match[0].length)
              if (boundaries.length >= MAX_AUTOLINK_PASSES) {
                break
              }
            }
            segmentStart = match.index + match[0].length
          }
          if (boundaries.length > 0) {
            rangeBoundaries.set(newRange.to, boundaries)
            maxPasses = Math.min(MAX_AUTOLINK_PASSES, Math.max(maxPasses, boundaries.length))
          }
        }

        const sharedTr = newState.tr
        const originalAddMark = sharedTr.addMark.bind(sharedTr)
        sharedTr.addMark = (from, to, mark) => {
          const originalText = newState.doc.textBetween(from, to)
          const href = restoreLinkText(
            mark.attrs.href,
            normalizeCjkLinkifySegment(originalText),
            originalText
          )
          return originalAddMark(
            from,
            to,
            href && href !== mark.attrs.href ? mark.type.create({ ...mark.attrs, href }) : mark
          )
        }

        for (let passIndex = 0; passIndex < maxPasses; passIndex += 1) {
          parentAppendTransaction.call(
            plugin,
            transactions,
            oldState,
            createLinkifyAwareState(newState, sharedTr, rangeBoundaries, passIndex)
          )
        }

        return sharedTr.steps.length > 0 ? sharedTr : undefined
      }
    }
    return plugins
  }
})
