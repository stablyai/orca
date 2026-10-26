import { describe, expect, it } from 'vitest'
import {
  shouldKeepHiddenWorktreeSurfacePaintable,
  shouldMountRetainedBrowserOverlay
} from './browser-worktree-surface-paintability'

describe('shouldKeepHiddenWorktreeSurfacePaintable', () => {
  // A hidden strict ancestor stops every guest’s screencast regardless of pane-level retention.
  it('keeps the surface painting for a guest a remote client needs', () => {
    expect(
      shouldKeepHiddenWorktreeSurfacePaintable({
        shouldMeasureHiddenWorktree: false,
        needsBrowserGuestPaint: true
      })
    ).toBe(true)
  })

  it('keeps the surface painting while a hidden worktree is being measured', () => {
    expect(
      shouldKeepHiddenWorktreeSurfacePaintable({
        shouldMeasureHiddenWorktree: true,
        needsBrowserGuestPaint: false
      })
    ).toBe(true)
  })

  it('parks the surface when nothing needs it', () => {
    expect(
      shouldKeepHiddenWorktreeSurfacePaintable({
        shouldMeasureHiddenWorktree: false,
        needsBrowserGuestPaint: false
      })
    ).toBe(false)
  })
})

describe('shouldMountRetainedBrowserOverlay', () => {
  it('mounts for a guest a remote client needs, even in a deferred hidden worktree', () => {
    expect(
      shouldMountRetainedBrowserOverlay({
        isWorktreeVisible: false,
        hasDeferredBackgroundMounts: true,
        needsBrowserGuestPaint: true
      })
    ).toBe(true)
  })

  it('mounts a visible worktree', () => {
    expect(
      shouldMountRetainedBrowserOverlay({
        isWorktreeVisible: true,
        hasDeferredBackgroundMounts: true,
        needsBrowserGuestPaint: false
      })
    ).toBe(true)
  })

  it('mounts a hidden worktree that is not deferring background mounts', () => {
    expect(
      shouldMountRetainedBrowserOverlay({
        isWorktreeVisible: false,
        hasDeferredBackgroundMounts: false,
        needsBrowserGuestPaint: false
      })
    ).toBe(true)
  })

  it('leaves a deferred hidden worktree unmounted when nothing needs its guests', () => {
    expect(
      shouldMountRetainedBrowserOverlay({
        isWorktreeVisible: false,
        hasDeferredBackgroundMounts: true,
        needsBrowserGuestPaint: false
      })
    ).toBe(false)
  })
})
