import type { HostedReviewState } from './hosted-review'
import type { CheckStatus } from './github/pull-request-types'

export type ReviewStatusTone =
  | 'neutral'
  | 'open'
  | 'success'
  | 'failure'
  | 'pending'
  | 'merged'
  | 'draft'
  | 'closed'
export type ReviewStatusGlyph = 'branch' | 'pull-request' | 'merge' | 'draft' | 'closed'

export type ReviewStatusPresentation = {
  glyph: ReviewStatusGlyph
  tone: ReviewStatusTone
  label: string
}

export function reviewStatusPresentation(input: {
  state?: HostedReviewState | 'unknown' | null
  checksStatus?: CheckStatus | null
  hasReview?: boolean
  showChecks?: boolean
}): ReviewStatusPresentation {
  if (input.hasReview === false) {
    return { glyph: 'branch', tone: 'neutral', label: 'No pull request' }
  }
  const state = input.state
  if (state === 'unknown') {
    return { glyph: 'branch', tone: 'neutral', label: 'Pull request status unknown' }
  }
  if (state === 'merged') {
    return { glyph: 'merge', tone: 'merged', label: 'Merged pull request' }
  }
  if (state === 'draft') {
    return { glyph: 'draft', tone: 'draft', label: 'Draft pull request' }
  }
  if (state === 'closed') {
    return { glyph: 'closed', tone: 'closed', label: 'Closed pull request' }
  }
  const checks = input.showChecks === false ? null : input.checksStatus
  if (checks === 'failure') {
    return {
      glyph: state === 'open' ? 'pull-request' : 'branch',
      tone: 'failure',
      label: 'Pull request checks failing'
    }
  }
  if (checks === 'pending') {
    return {
      glyph: state === 'open' ? 'pull-request' : 'branch',
      tone: 'pending',
      label: 'Pull request checks pending'
    }
  }
  if (state === 'open') {
    return {
      glyph: 'pull-request',
      tone: checks === 'success' ? 'success' : 'open',
      label: checks === 'success' ? 'Open pull request, checks passing' : 'Open pull request'
    }
  }
  return { glyph: 'branch', tone: 'neutral', label: 'Pull request status unknown' }
}
