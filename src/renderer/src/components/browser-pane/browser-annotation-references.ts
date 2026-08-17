import {
  GRAB_BUDGET,
  type BrowserAnnotationReference,
  type BrowserGrabPayload,
  type BrowserGrabPoint
} from '../../../../shared/browser-grab-types'

// Why: annotations target one element, but design feedback is relational ("move
// this below the footer"). A reference is a second picked element the comment
// addresses through an `@ref<n>` token.

export const BROWSER_ANNOTATION_REFERENCE_TOKEN_PREFIX = '@ref'

export function browserAnnotationReferenceToken(index: number): string {
  return `${BROWSER_ANNOTATION_REFERENCE_TOKEN_PREFIX}${index}`
}

/**
 * A click in an element's own gap is a position, not that element. The guest
 * decides this by hit-testing the click against the element's children, so a
 * gap inside any container counts — not just bare page background.
 */
export function isBrowserAnnotationPointReference(
  reference: BrowserAnnotationReference
): reference is BrowserAnnotationReference & { point: BrowserGrabPoint } {
  return reference.point?.inEmptySpace === true
}

/** How a spot is described: share the clamp so chip and prompt never disagree. */
export function browserAnnotationReferencePercent(ratio: number): number {
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 100)
}

/** Same identity cues the composer header shows, so a chip reads like the element. */
export function browserAnnotationReferenceLabel(payload: BrowserGrabPayload): string {
  const { target } = payload
  if (payload.clickPoint?.inEmptySpace) {
    const { ratioX, ratioY } = payload.clickPoint
    const host = target.tagName || 'page'
    const across = browserAnnotationReferencePercent(ratioX)
    const down = browserAnnotationReferencePercent(ratioY)
    return truncateLabel(`spot in ${host} (${across}% across, ${down}% down)`)
  }
  const name = collapseLabelText(target.accessibility.accessibleName ?? '')
  if (name) {
    return truncateLabel(`${target.tagName} "${name}"`)
  }
  const text = collapseLabelText(target.textSnippet ?? '')
  if (text) {
    return truncateLabel(`${target.tagName} "${text}"`)
  }
  return truncateLabel(target.tagName || 'element')
}

/** Bound before collapsing: page-controlled text can be far longer than a label. */
function collapseLabelText(content: string): string {
  return content
    .slice(0, GRAB_BUDGET.annotationReferenceLabelMaxLength * 2)
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateLabel(label: string): string {
  return label.length > GRAB_BUDGET.annotationReferenceLabelMaxLength
    ? `${label.slice(0, GRAB_BUDGET.annotationReferenceLabelMaxLength - 1)}…`
    : label
}

export function createBrowserAnnotationReference(
  payload: BrowserGrabPayload,
  index: number
): BrowserAnnotationReference {
  const { target } = payload
  return {
    index,
    label: browserAnnotationReferenceLabel(payload),
    tagName: target.tagName,
    selector: target.selector,
    ...(target.elementPath ? { elementPath: target.elementPath } : {}),
    ...(target.isFixed ? { isFixed: true } : {}),
    rectViewport: target.rectViewport,
    rectPage: target.rectPage,
    ...(payload.clickPoint ? { point: payload.clickPoint } : {})
  }
}

/** Indexes stay 1..n so a visible token can never point past the end of the list. */
export function appendBrowserAnnotationReference(
  references: BrowserAnnotationReference[],
  payload: BrowserGrabPayload
): BrowserAnnotationReference[] {
  if (references.length >= GRAB_BUDGET.annotationReferencesMax) {
    return references
  }
  return [...references, createBrowserAnnotationReference(payload, references.length + 1)]
}

/** Renumbers to 1..n; the comment's tokens are shifted to match by `removeReferenceTokenFromComment`. */
export function removeBrowserAnnotationReference(
  references: BrowserAnnotationReference[],
  index: number
): BrowserAnnotationReference[] {
  return references
    .filter((reference) => reference.index !== index)
    .map((reference, position) => ({ ...reference, index: position + 1 }))
}

/** Clamp for persisted state — caps count and renumbers to 1..n. */
export function clampBrowserAnnotationReferences(
  references: BrowserAnnotationReference[] | undefined
): BrowserAnnotationReference[] | undefined {
  if (!references || references.length === 0) {
    return undefined
  }
  return references.slice(0, GRAB_BUDGET.annotationReferencesMax).map((reference, position) => ({
    ...reference,
    index: position + 1,
    label: truncateLabel(reference.label)
  }))
}

export type ReferenceTokenInsertion = {
  comment: string
  caret: number
}

/** Pads with single spaces so the token never fuses with adjacent words. */
export function insertBrowserAnnotationReferenceToken(
  comment: string,
  selectionStart: number,
  selectionEnd: number,
  token: string
): ReferenceTokenInsertion {
  const start = clampCaret(selectionStart, comment.length)
  const end = clampCaret(Math.max(selectionEnd, selectionStart), comment.length)
  const before = comment.slice(0, start)
  const after = comment.slice(end)
  const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const suffix = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const insertion = `${prefix}${token}${suffix}`
  return {
    comment: `${before}${insertion}${after}`,
    caret: before.length + prefix.length + token.length
  }
}

function clampCaret(value: number, length: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return length
  }
  return Math.min(Math.trunc(value), length)
}

/**
 * Drops the removed reference's token and shifts the higher ones down.
 * Why renumber the text too: the list renumbers to stay 1..n, so leaving the
 * old numbers in the comment would silently repoint them at other references.
 */
export function removeReferenceTokenFromComment(comment: string, removedIndex: number): string {
  return comment
    .replace(/@ref(\d{1,3})\b/g, (match, digits: string) => {
      const index = Number(digits)
      if (index === removedIndex) {
        return ''
      }
      return index > removedIndex
        ? `${BROWSER_ANNOTATION_REFERENCE_TOKEN_PREFIX}${index - 1}`
        : match
    })
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[^\S\n]+([.,;:!?])/g, '$1')
}

/** Last-resort net at submit: a token with no reference must not reach the agent. */
export function stripUnresolvedReferenceTokens(
  comment: string,
  references: BrowserAnnotationReference[]
): string {
  const known = new Set(references.map((reference) => reference.index))
  return comment
    .replace(/@ref(\d{1,3})\b/g, (match, digits: string) =>
      known.has(Number(digits)) ? match : ''
    )
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
}
