// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceColorTagFallbackIdentity } from '../../../../shared/workspace-color-tag'
import {
  clearWorkspaceColorTagPreviews,
  clearWorkspaceColorTagPreviewsFor,
  createWorkspaceColorTagPreviewOwner,
  previewWorkspaceColorTagsFor,
  readWorkspaceColorTagPreview,
  setWorkspaceColorTagPreviews,
  useWorkspaceColorTagPreview,
  useWorkspaceColorTagPreviewForWorktree,
  useWorkspaceColorTagPreviewsForWorktrees
} from './workspace-color-tag-preview'

const IDS = ['h::a', 'h::b', 'h::c']

describe('workspace color tag preview readers across identity promotion', () => {
  const owner = createWorkspaceColorTagPreviewOwner()
  const promoted = {
    id: 'repo::w',
    hostId: 'ssh:box',
    identity: { key: 'k-promo' }
  } as unknown as Worktree
  const identityLess = { id: 'repo::w', hostId: 'ssh:box' } as unknown as Worktree
  const fallbackKey = getWorkspaceColorTagFallbackIdentity(promoted)
  afterEach(() =>
    act(() => {
      clearWorkspaceColorTagPreviews(['k-promo', fallbackKey], owner)
    })
  )

  // Regression: the picker previewed under the key the row had when it opened; a refresh that
  // promoted the row mid-session re-subscribed the card under its canonical key, where nothing was
  // written, and the strip snapped back until the write landed.
  it('reads a preview left under the fallback key once the row has an identity', () => {
    const { result } = renderHook(() => useWorkspaceColorTagPreviewForWorktree(promoted))
    expect(result.current).toBeUndefined()
    act(() => setWorkspaceColorTagPreviews([fallbackKey], '#ef4444', owner))
    expect(result.current).toBe('#ef4444')
  })

  // Regression: a checkout replaced at the same path while its predecessor's write was pending read
  // the predecessor's fallback layer and showed its pending color until that request settled.
  it('hides a fallback layer set on behalf of another identity from a row that has its own', () => {
    const replacement = {
      id: 'repo::w',
      hostId: 'ssh:box',
      identity: { key: 'k-replacement' }
    } as unknown as Worktree
    const view = renderHook(() => useWorkspaceColorTagPreviewForWorktree(replacement))
    const copy = renderHook(() => useWorkspaceColorTagPreviewForWorktree(identityLess))
    act(() =>
      setWorkspaceColorTagPreviews([fallbackKey], '#ef4444', owner, { forIdentity: 'k-old' })
    )
    expect(view.result.current).toBeUndefined()
    expect(copy.result.current).toBe('#ef4444')
    act(() => setWorkspaceColorTagPreviews([fallbackKey], '#22c55e', owner))
    expect(view.result.current).toBe('#22c55e')
  })

  it('prefers the canonical key and reads a previewed clear as null, not as nothing', () => {
    const { result } = renderHook(() => useWorkspaceColorTagPreviewForWorktree(promoted))
    act(() => setWorkspaceColorTagPreviews([fallbackKey], '#ef4444', owner))
    act(() => setWorkspaceColorTagPreviews(['k-promo'], null, owner))
    expect(result.current).toBeNull()
  })

  it('reports a list of rows in order, undefined where nothing is previewed', () => {
    const { result } = renderHook(() =>
      useWorkspaceColorTagPreviewsForWorktrees([promoted, identityLess])
    )
    expect(result.current).toEqual([undefined, undefined])
    act(() => setWorkspaceColorTagPreviews(['k-promo'], '#22c55e', owner))
    expect(result.current).toEqual(['#22c55e', undefined])
    // A later pre-identity layer set for another occupant does not apply to the promoted row.
    act(() => setWorkspaceColorTagPreviews([fallbackKey], null, owner, { forIdentity: 'k-other' }))
    expect(result.current).toEqual(['#22c55e', null])
  })
})

describe('previewWorkspaceColorTagsFor', () => {
  const owner = createWorkspaceColorTagPreviewOwner()
  const promoted = {
    id: 'repo::p',
    hostId: 'ssh:box',
    identity: { key: 'k-p' }
  } as unknown as Worktree
  const copy = { id: 'repo::p', hostId: 'ssh:box' } as unknown as Worktree
  const replacement = {
    id: 'repo::p',
    hostId: 'ssh:box',
    identity: { key: 'k-r' }
  } as unknown as Worktree
  afterEach(() => act(() => clearWorkspaceColorTagPreviewsFor([promoted, copy], owner)))

  // Regression: the picker previewed under canonical keys only, so a copy of the row that had not
  // refreshed yet did not follow the wheel until the write landed.
  it('reaches the canonical row and an identity-less copy, but not a replacement occupant', () => {
    previewWorkspaceColorTagsFor([promoted], '#ef4444', owner)
    expect(readWorkspaceColorTagPreview(promoted)).toBe('#ef4444')
    expect(readWorkspaceColorTagPreview(copy)).toBe('#ef4444')
    expect(readWorkspaceColorTagPreview(replacement)).toBeUndefined()
    clearWorkspaceColorTagPreviewsFor([promoted], owner)
    expect(readWorkspaceColorTagPreview(promoted)).toBeUndefined()
    expect(readWorkspaceColorTagPreview(copy)).toBeUndefined()
  })

  // Regression: the reader returned the canonical key's layer unconditionally, so an older pending
  // write's preview hid a newer picker preview published from an identity-less copy of the row.
  it('shows the newest layer across both keys, whichever key it lives under', () => {
    const pending = createWorkspaceColorTagPreviewOwner()
    const picker = createWorkspaceColorTagPreviewOwner()
    try {
      setWorkspaceColorTagPreviews(['k-p'], '#111111', pending)
      previewWorkspaceColorTagsFor([copy], '#222222', picker)
      expect(readWorkspaceColorTagPreview(promoted)).toBe('#222222')
      expect(readWorkspaceColorTagPreview(copy)).toBe('#222222')
      clearWorkspaceColorTagPreviewsFor([copy], picker)
      expect(readWorkspaceColorTagPreview(promoted)).toBe('#111111')
      setWorkspaceColorTagPreviews(['k-p'], '#333333', pending)
      previewWorkspaceColorTagsFor([copy], '#444444', picker)
      setWorkspaceColorTagPreviews(['k-p'], '#555555', pending)
      expect(readWorkspaceColorTagPreview(promoted)).toBe('#555555')
    } finally {
      clearWorkspaceColorTagPreviews(['k-p'], pending)
      clearWorkspaceColorTagPreviewsFor([copy], picker)
    }
  })

  it('scopes an identity-less row to the occupant its caller knows', () => {
    previewWorkspaceColorTagsFor([copy], '#22c55e', owner, 'k-p')
    expect(readWorkspaceColorTagPreview(promoted)).toBe('#22c55e')
    expect(readWorkspaceColorTagPreview(copy)).toBe('#22c55e')
    expect(readWorkspaceColorTagPreview(replacement)).toBeUndefined()
  })
})

describe('workspace color tag preview channel', () => {
  const owner = createWorkspaceColorTagPreviewOwner()
  const other = createWorkspaceColorTagPreviewOwner()
  afterEach(() =>
    act(() => {
      clearWorkspaceColorTagPreviews(IDS, owner)
      clearWorkspaceColorTagPreviews(IDS, other)
    })
  )

  it('sets and clears every identity in the batch', () => {
    const a = renderHook(() => useWorkspaceColorTagPreview('h::a'))
    const c = renderHook(() => useWorkspaceColorTagPreview('h::c'))

    act(() => setWorkspaceColorTagPreviews(IDS, '#112233', owner))
    expect(a.result.current).toBe('#112233')
    expect(c.result.current).toBe('#112233')

    act(() => clearWorkspaceColorTagPreviews(IDS, owner))
    expect(a.result.current).toBeUndefined()
    expect(c.result.current).toBeUndefined()
  })

  it('leaves identities outside the batch alone', () => {
    const z = renderHook(() => useWorkspaceColorTagPreview('h::z'))
    act(() => setWorkspaceColorTagPreviews(IDS, '#112233', owner))
    expect(z.result.current).toBeUndefined()
  })

  it('is stable under repeated identical writes', () => {
    const a = renderHook(() => useWorkspaceColorTagPreview('h::a'))
    act(() => setWorkspaceColorTagPreviews(IDS, '#112233', owner))
    act(() => setWorkspaceColorTagPreviews(IDS, '#112233', owner))
    expect(a.result.current).toBe('#112233')
  })

  // Regression: a picker holding its preview through a slow write cleared identity-wide when the
  // write landed, erasing a newer live preview another picker had set on the same card.
  it('lets a clear remove only what its owner set', () => {
    const a = renderHook(() => useWorkspaceColorTagPreview('h::a'))
    act(() => setWorkspaceColorTagPreviews(IDS, '#111111', owner))
    act(() => setWorkspaceColorTagPreviews(IDS, '#222222', other))
    expect(a.result.current).toBe('#222222')

    act(() => clearWorkspaceColorTagPreviews(IDS, owner))
    expect(a.result.current).toBe('#222222')

    act(() => clearWorkspaceColorTagPreviews(IDS, other))
    expect(a.result.current).toBeUndefined()
  })

  // Regression: a pending write held a preview and the user dragged a custom color over it; the
  // drag replaced the single slot, so Escape on the picker dropped both and the card snapped to the
  // persisted strip until the RPC landed.
  it('reveals the layer beneath when the top owner clears', () => {
    const a = renderHook(() => useWorkspaceColorTagPreview('h::a'))
    act(() => setWorkspaceColorTagPreviews(IDS, '#111111', owner))
    act(() => setWorkspaceColorTagPreviews(IDS, '#222222', other))
    expect(a.result.current).toBe('#222222')

    act(() => clearWorkspaceColorTagPreviews(IDS, other))
    expect(a.result.current).toBe('#111111')

    act(() => setWorkspaceColorTagPreviews(IDS, '#333333', other))
    act(() => setWorkspaceColorTagPreviews(IDS, '#444444', owner))
    // Re-setting an owner moves its layer to the top.
    expect(a.result.current).toBe('#444444')
    act(() => clearWorkspaceColorTagPreviews(IDS, owner))
    expect(a.result.current).toBe('#333333')
  })
})
