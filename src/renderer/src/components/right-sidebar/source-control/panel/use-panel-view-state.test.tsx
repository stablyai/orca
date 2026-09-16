// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { useSourceControlPanelViewState } from './use-panel-view-state'

/** Mimics the zustand settings slice closely enough for this hook: updateSettings
 *  merges into the settings object the next render reads back, like the real store does. */
function createSettingsHarness(initial: GlobalSettings) {
  let settings = initial
  const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
  })
  return {
    getSettings: () => settings,
    updateSettings
  }
}

describe('branch section collapse persistence (issue #18616)', () => {
  it('keeps "Committed on Branch" collapsed across a workspace switch', () => {
    const harness = createSettingsHarness(createGlobalSettingsFixture())
    const { result, rerender } = renderHook(
      (props: { activeWorktreeId: string | null }) =>
        useSourceControlPanelViewState({
          activeWorktreeId: props.activeWorktreeId,
          settings: harness.getSettings(),
          updateSettings: harness.updateSettings
        }),
      { initialProps: { activeWorktreeId: 'worktree-a' } }
    )

    expect(result.current.collapsedSections.has('branch')).toBe(false)

    act(() => {
      result.current.toggleSection('branch')
    })
    expect(result.current.collapsedSections.has('branch')).toBe(true)
    expect(harness.updateSettings).toHaveBeenCalledWith({
      sourceControlBranchSectionCollapsed: true
    })

    // Switch to a different workspace.
    rerender({ activeWorktreeId: 'worktree-b' })
    // Switch back.
    rerender({ activeWorktreeId: 'worktree-a' })

    expect(result.current.collapsedSections.has('branch')).toBe(true)
  })

  it('still resets the other sections on a workspace switch', () => {
    const harness = createSettingsHarness(createGlobalSettingsFixture())
    const { result, rerender } = renderHook(
      (props: { activeWorktreeId: string | null }) =>
        useSourceControlPanelViewState({
          activeWorktreeId: props.activeWorktreeId,
          settings: harness.getSettings(),
          updateSettings: harness.updateSettings
        }),
      { initialProps: { activeWorktreeId: 'worktree-a' } }
    )

    act(() => {
      result.current.toggleSection('staged')
    })
    expect(result.current.collapsedSections.has('staged')).toBe(true)

    rerender({ activeWorktreeId: 'worktree-b' })

    expect(result.current.collapsedSections.has('staged')).toBe(false)
  })
})
