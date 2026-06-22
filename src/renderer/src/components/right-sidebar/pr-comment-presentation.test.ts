// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PR_COMMENT_PRESENTATION_VARIANT,
  getPRCommentPresentationClasses,
  resolvePRCommentPresentationVariant
} from './pr-comment-presentation'

describe('pr-comment-presentation', () => {
  it('defaults to cards layout', () => {
    expect(DEFAULT_PR_COMMENT_PRESENTATION_VARIANT).toBe('cards')
  })

  it('returns card layout tokens for cards and focus variants', () => {
    const cards = getPRCommentPresentationClasses('cards')
    expect(cards.useCardLayout).toBe(true)
    expect(cards.commentBody).toContain('text-[13px]')
    expect(cards.commentBody).toContain('text-foreground')
    expect(cards.group).toContain('bg-secondary')
    expect(cards.group).toContain('shadow-xs')
    expect(cards.avatar).toContain('border-border')
    expect(cards.avatar).toContain('bg-background')

    expect(getPRCommentPresentationClasses('focus').useCardLayout).toBe(true)
    expect(getPRCommentPresentationClasses('focus').commentBody).toContain('text-[14px]')
  })

  it('preserves the legacy flat layout tokens', () => {
    const flat = getPRCommentPresentationClasses('flat')
    expect(flat.useCardLayout).toBe(false)
    expect(flat.commentBody).toContain('text-muted-foreground')
    expect(flat.commentBody).toContain('text-[11px]')
  })

  it('falls back to the default variant when localStorage is unset', () => {
    window.localStorage.removeItem('orca:pr-comment-presentation')
    expect(resolvePRCommentPresentationVariant()).toBe(DEFAULT_PR_COMMENT_PRESENTATION_VARIANT)
  })
})
