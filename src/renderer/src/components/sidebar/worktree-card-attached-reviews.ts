import type { AttachedReview } from '../../../../shared/types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

/** One review as the hover renders it, whether Orca found it or the user attached it. */
export type CardReviewRow = {
  provider: AttachedReview['provider']
  number: number
  url: string
  baseRef?: string
  title?: string
  /** Present only for the review Orca resolved on its own. */
  state?: WorktreeCardPrDisplay['state']
  status?: WorktreeCardPrDisplay['status']
}

export type CardReviewList =
  /** One review: the rich section, which has room for title and badges. */
  | { kind: 'single' }
  /** Several: a uniform list, because a stack of destinations reads as a stack. */
  | { kind: 'list'; rows: CardReviewRow[] }

/**
 * Decides how a workspace's reviews are rendered.
 *
 * A branch that ships to one place has one review and deserves the detailed
 * section. A branch that ships to three has three peers — singling one out as
 * the header just because Orca happened to auto-detect it makes the other two
 * look secondary when they are the same kind of thing.
 *
 * The auto-detected review keeps its state and checks in the list; it is the
 * only one Orca actually polled, so dropping that would lose real information.
 */
export function getCardReviewList(
  attachedReviews: readonly AttachedReview[] | null | undefined,
  primary: WorktreeCardPrDisplay | null
): CardReviewList {
  const rows: CardReviewRow[] = []
  const seen = new Set<string>()

  const push = (row: CardReviewRow): void => {
    const key = normalizeUrl(row.url) || `${row.provider}#${row.number}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    rows.push(row)
  }

  // Los hermanos vienen del mismo lookup que el review principal, así que están
  // tan frescos como él: van primero para que una lista adjunta a mano no tape
  // lo que Orca ya sabe de la rama.
  for (const sib of siblingsOf(primary)) {
    push(sib)
  }

  for (const review of attachedReviews ?? []) {
    push(matchesPrimary(review, primary) ? mergeWithPrimary(review, primary) : toRow(review))
  }

  // The auto-detected review may not be among the attached ones — nothing
  // requires the user to attach the review Orca already knows about. A provider
  // Orca does not support is skipped: the row could not be given an icon or a
  // label, and the detailed section already handles it.
  if (
    primary?.url &&
    isSupported(primary.provider) &&
    !rows.some((row) => matchesPrimary(row, primary))
  ) {
    push({
      provider: primary.provider,
      number: primary.number,
      url: primary.url,
      // El principal es el único que Orca poll-ea, pero sin su destino queda
      // como la única fila que no dice a dónde va — justo lo que distingue una
      // review de otra de la misma rama.
      ...('baseRefName' in primary && primary.baseRefName ? { baseRef: primary.baseRefName } : {}),
      ...(primary.title ? { title: primary.title } : {}),
      ...(primary.state ? { state: primary.state } : {}),
      ...(primary.status ? { status: primary.status } : {})
    })
  }

  return rows.length > 1 ? { kind: 'list', rows } : { kind: 'single' }
}

/** El estado que el caller asertó vale como el que Orca consultó: si no, una
 *  review mergeada y una abierta se ven igual. */
function toRow(review: AttachedReview): CardReviewRow {
  return { ...review, ...(review.state ? { state: review.state } : {}) }
}

/**
 * Los PRs que la rama alimenta además del principal.
 *
 * Salen del mismo request, así que no hay nada que sincronizar aparte: se
 * refrescan cuando se refresca el review de la rama.
 */
function siblingsOf(primary: WorktreeCardPrDisplay | null): CardReviewRow[] {
  const list = primary && 'siblings' in primary ? primary.siblings : undefined
  if (!list?.length || !primary || primary.provider === 'unsupported') {
    return []
  }
  return list
    .filter((sib) => Boolean(sib.url))
    .map((sib) => ({
      provider: primary.provider as AttachedReview['provider'],
      number: sib.number,
      url: sib.url,
      ...(sib.baseRef ? { baseRef: sib.baseRef } : {}),
      ...(sib.title ? { title: sib.title } : {}),
      ...(sib.state ? { state: sib.state } : {})
    }))
}

function mergeWithPrimary(
  review: AttachedReview,
  primary: WorktreeCardPrDisplay | null
): CardReviewRow {
  return {
    ...review,
    // The attached title wins: it is what the user chose to record, and a
    // fan-out convention usually encodes the destination in it.
    ...(review.title || primary?.title ? { title: review.title ?? primary?.title } : {}),
    ...(primary?.state ? { state: primary.state } : {}),
    ...(primary?.status ? { status: primary.status } : {})
  }
}

function matchesPrimary(
  review: Pick<CardReviewRow, 'provider' | 'number' | 'url'>,
  primary: WorktreeCardPrDisplay | null
): boolean {
  if (!primary) {
    return false
  }
  if (primary.url && normalizeUrl(review.url) === normalizeUrl(primary.url)) {
    return true
  }
  return review.provider === primary.provider && review.number === primary.number
}

function isSupported(
  provider: WorktreeCardPrDisplay['provider']
): provider is AttachedReview['provider'] {
  return provider !== 'unsupported'
}

function normalizeUrl(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '')
}
