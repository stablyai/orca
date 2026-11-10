// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import { WorkspaceDirectorySetting } from './WorkspaceDirectorySetting'

vi.mock('../section-layout/SearchableSetting', () => ({
  SearchableSetting: ({ children }) => children
}))
vi.mock('../../sidebar/worktree-list/controls/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: [] })
}))
afterEach(cleanup)

describe('WorkspaceDirectorySetting', () => {
  it('shows the saved path and writes nothing when a padded copy of it is committed', () => {
    const updateSettings = vi.fn()
    render(
      <WorkspaceDirectorySetting
        settings={createGlobalSettingsFixture({ workspaceDir: '/Users/me/dev' })}
        updateSettings={updateSettings}
      />
    )
    const input = screen.getByRole<HTMLInputElement>('textbox')

    fireEvent.change(input, { target: { value: ' /Users/me/dev' } })
    fireEvent.blur(input)

    expect(input.value).toBe('/Users/me/dev')
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
