import { describe, expect, it, vi } from 'vitest'
import {
  pinDirtySettingsNavSections,
  releaseSettledSettingsNavGuard,
  runSettingsSectionLeaveConfirmation,
  settleAppearanceSettingsSectionBeforeLeave
} from './settings-section-navigation'

describe('settings section navigation', () => {
  it('settles only Appearance when navigating away from a dirty Appearance section', async () => {
    const confirmAppearance = vi.fn().mockResolvedValue(true)
    const confirmSourceControl = vi.fn().mockResolvedValue(true)
    const discardAppearance = vi.fn()

    await expect(
      runSettingsSectionLeaveConfirmation('appearance', {
        appearance: () =>
          settleAppearanceSettingsSectionBeforeLeave({
            dirty: true,
            confirmLeave: confirmAppearance,
            discardDraft: discardAppearance
          }),
        sourceControl: confirmSourceControl
      })
    ).resolves.toBe(true)

    expect(confirmAppearance).toHaveBeenCalledWith({ discardDraftOnLeave: false })
    expect(discardAppearance).toHaveBeenCalledOnce()
    expect(confirmSourceControl).not.toHaveBeenCalled()
  })

  it('preserves the Appearance draft when leaving is canceled', async () => {
    const discardAppearance = vi.fn()

    await expect(
      settleAppearanceSettingsSectionBeforeLeave({
        dirty: true,
        confirmLeave: vi.fn().mockResolvedValue(false),
        discardDraft: discardAppearance
      })
    ).resolves.toBe(false)

    expect(discardAppearance).not.toHaveBeenCalled()
  })

  it('settles only Source Control when navigating away from Git', async () => {
    const confirmAppearance = vi.fn().mockResolvedValue(true)
    const confirmSourceControl = vi.fn().mockResolvedValue(false)

    await expect(
      runSettingsSectionLeaveConfirmation('git', {
        appearance: confirmAppearance,
        sourceControl: confirmSourceControl
      })
    ).resolves.toBe(false)

    expect(confirmAppearance).not.toHaveBeenCalled()
    expect(confirmSourceControl).toHaveBeenCalledOnce()
  })

  it('does not settle unrelated sections', async () => {
    const confirmAppearance = vi.fn().mockResolvedValue(false)
    const confirmSourceControl = vi.fn().mockResolvedValue(false)

    await expect(
      runSettingsSectionLeaveConfirmation('general', {
        appearance: confirmAppearance,
        sourceControl: confirmSourceControl
      })
    ).resolves.toBe(true)

    expect(confirmAppearance).not.toHaveBeenCalled()
    expect(confirmSourceControl).not.toHaveBeenCalled()
  })

  it('pins dirty Appearance and Git sections when search has no matches', () => {
    const git = { id: 'git' }
    const appearance = { id: 'appearance' }
    const sectionById = new Map([
      [git.id, git],
      [appearance.id, appearance]
    ])

    expect(
      pinDirtySettingsNavSections([], sectionById, {
        appearance: true,
        sourceControl: true
      })
    ).toEqual([git, appearance])
  })

  it('does not duplicate dirty sections already matched by search', () => {
    const appearance = { id: 'appearance' }

    expect(
      pinDirtySettingsNavSections([appearance], new Map([[appearance.id, appearance]]), {
        appearance: true,
        sourceControl: false
      })
    ).toEqual([appearance])
  })

  it('releases a settled stale guard without clearing a newer navigation guard', () => {
    expect(releaseSettledSettingsNavGuard('appearance', 'appearance')).toBeNull()
    expect(releaseSettledSettingsNavGuard('git', 'appearance')).toBe('git')
  })
})
