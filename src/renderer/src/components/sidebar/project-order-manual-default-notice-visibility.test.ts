import { describe, expect, it } from 'vitest'
import { resolveProjectOrderManualDefaultNoticeDismissed } from '../../../../shared/project-order-manual-default-notice'
import { shouldShowProjectOrderManualDefaultNotice } from './project-order-manual-default-notice-visibility'

describe('resolveProjectOrderManualDefaultNoticeDismissed', () => {
  it('keeps an explicit dismissal', () => {
    expect(
      resolveProjectOrderManualDefaultNoticeDismissed({
        rawDismissed: true,
        rawProjectOrderBy: undefined,
        isExistingProfile: true
      })
    ).toBe(true)
  })

  it('hides the notice for brand-new profiles', () => {
    expect(
      resolveProjectOrderManualDefaultNoticeDismissed({
        rawDismissed: undefined,
        rawProjectOrderBy: undefined,
        isExistingProfile: false
      })
    ).toBe(true)
  })

  it('hides the notice when recent ordering was already explicit', () => {
    expect(
      resolveProjectOrderManualDefaultNoticeDismissed({
        rawDismissed: undefined,
        rawProjectOrderBy: 'recent',
        isExistingProfile: true
      })
    ).toBe(true)
  })

  it('shows the notice for upgraded profiles without an explicit project order', () => {
    expect(
      resolveProjectOrderManualDefaultNoticeDismissed({
        rawDismissed: undefined,
        rawProjectOrderBy: undefined,
        isExistingProfile: true
      })
    ).toBe(false)
  })
})

describe('shouldShowProjectOrderManualDefaultNotice', () => {
  it('shows only when project grouping is active and repos exist', () => {
    expect(
      shouldShowProjectOrderManualDefaultNotice({
        persistedUIReady: true,
        projectOrderManualDefaultNoticeDismissed: false,
        groupBy: 'repo',
        projectOrderBy: 'manual',
        repoCount: 2
      })
    ).toBe(true)
    expect(
      shouldShowProjectOrderManualDefaultNotice({
        persistedUIReady: true,
        projectOrderManualDefaultNoticeDismissed: false,
        groupBy: 'none',
        projectOrderBy: 'manual',
        repoCount: 2
      })
    ).toBe(false)
    expect(
      shouldShowProjectOrderManualDefaultNotice({
        persistedUIReady: true,
        projectOrderManualDefaultNoticeDismissed: false,
        groupBy: 'repo',
        projectOrderBy: 'manual',
        repoCount: 0
      })
    ).toBe(false)

    expect(
      shouldShowProjectOrderManualDefaultNotice({
        persistedUIReady: true,
        projectOrderManualDefaultNoticeDismissed: false,
        groupBy: 'repo',
        projectOrderBy: 'recent',
        repoCount: 2
      })
    ).toBe(false)
  })
})
